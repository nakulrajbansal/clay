// ClayStore: the trusted facade over user.db + system.db. Commits span
// DDL + backfills + registry update + version_log append in ONE
// transaction (doc 04 §4). Versioning is a linear chain (doc 04 §5):
// rollback applies inverses; roll-forward (pre-truncation) re-applies
// forward ops; truncation is the only destructive-ish operation (ADR-007).
import { ClayError } from "./errors";
import {
  createSystemTables, openMemoryDriver,
  type DbDriver, type SqlRow, type SqlValue,
} from "./db";
import {
  cloneRegistry, getTable, type Registry, type RegTable,
} from "./registry";
import { nowIso, uuidv7, validateInsert, validatePatch } from "./rows";
import {
  applyForwardOps, applyInverseOps, validateMigrationPlan,
  type MigrationPlanT,
} from "./migrate";
import { runQuery, type QueryRow } from "./query";

type QueryT = import("@clay/schema").Query;

export type CommitInput = {
  intent: string;
  summary: string;
  migration: MigrationPlanT | null;
  diff?: unknown;
};

export type VersionEntry = {
  version: number;
  parent: number;
  created_at: string;
  intent_text: string;
  summary: string;
  migration: MigrationPlanT | null;
};

const qid = (name: string): string => `"${name}"`;

export class ClayStore {
  private reg: Registry = new Map();

  private constructor(private readonly driver: DbDriver) {}

  static async openMemory(): Promise<ClayStore> {
    const driver = await openMemoryDriver();
    createSystemTables(driver);
    const store = new ClayStore(driver);
    store.loadRegistry();
    return store;
  }

  close(): void {
    this.driver.close();
  }

  // ---------- registry ----------
  private loadRegistry(): void {
    this.reg = new Map();
    for (const row of this.driver.select("SELECT spec_json FROM sys.tables_registry")) {
      const spec = JSON.parse(String(row.spec_json)) as RegTable;
      this.reg.set(spec.name, spec);
    }
  }

  private persistRegistry(version: number): void {
    this.driver.exec("DELETE FROM sys.tables_registry");
    for (const t of this.reg.values()) {
      this.driver.exec(
        `INSERT INTO sys.tables_registry(table_name, version, spec_json, created_by, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [t.name, version, JSON.stringify(t), "kernel", nowIso()]);
    }
  }

  registrySnapshot(): Registry {
    return cloneRegistry(this.reg);
  }

  // ---------- versions ----------
  headVersion(): number {
    const rows = this.driver.select("SELECT MAX(version) AS v FROM sys.version_log");
    return Number(rows[0]?.v ?? 0);
  }

  currentVersion(): number {
    const rows = this.driver.select(
      "SELECT value_json FROM sys.settings WHERE key = 'current_version'");
    const raw = rows[0]?.value_json;
    return raw === undefined ? this.headVersion() : Number(JSON.parse(String(raw)));
  }

  private setCurrentVersion(v: number): void {
    this.driver.exec(
      `INSERT INTO sys.settings(key, value_json) VALUES ('current_version', ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      [JSON.stringify(v)]);
  }

  getEntry(version: number): VersionEntry {
    const rows = this.driver.select(
      "SELECT * FROM sys.version_log WHERE version = ?", [version]);
    const r = rows[0];
    if (!r) throw new ClayError("E_VALIDATION", `no version ${version}`);
    const migration = r.migration_json === null
      ? null
      : {
          operations: JSON.parse(String(r.migration_json)) as MigrationPlanT["operations"],
          inverse: JSON.parse(String(r.inverse_json)) as MigrationPlanT["inverse"],
        };
    return {
      version: Number(r.version), parent: Number(r.parent),
      created_at: String(r.created_at), intent_text: String(r.intent_text),
      summary: String(r.summary), migration,
    };
  }

  /** Commit a mutation: validate, migrate, persist registry, append log. */
  commit(input: CommitInput): number {
    const head = this.headVersion();
    if (this.currentVersion() !== head)
      throw new ClayError("E_VALIDATION",
        "store is rolled back (scrub preview); roll forward or truncate first");
    try {
      return this.driver.tx(() => {
        if (input.migration) {
          validateMigrationPlan(input.migration, this.reg);
          applyForwardOps(this.driver, this.reg, input.migration.operations);
        }
        const version = head + 1;
        this.persistRegistry(version);
        this.driver.exec(
          `INSERT INTO sys.version_log(version, parent, created_at, intent_text,
             summary, diff_json, migration_json, inverse_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [version, head, nowIso(), input.intent, input.summary,
           JSON.stringify(input.diff ?? []),
           input.migration ? JSON.stringify(input.migration.operations) : null,
           input.migration ? JSON.stringify(input.migration.inverse) : null]);
        this.setCurrentVersion(version);
        return version;
      });
    } catch (e) {
      this.loadRegistry();   // in-memory registry may be ahead of the rolled-back tx
      throw e;
    }
  }

  /** Apply inverses current..K+1. With truncate, the chain above K is discarded. */
  rollbackTo(target: number, opts: { truncate?: boolean } = {}): void {
    const cur = this.currentVersion();
    if (target < 0 || target >= cur)
      throw new ClayError("E_VALIDATION", `cannot roll back from ${cur} to ${target}`);
    try {
      this.driver.tx(() => {
        for (let v = cur; v > target; v--) {
          const entry = this.getEntry(v);
          if (entry.migration)
            applyInverseOps(this.driver, this.reg, entry.migration.inverse);
        }
        this.persistRegistry(target);
        if (opts.truncate)
          this.driver.exec("DELETE FROM sys.version_log WHERE version > ?", [target]);
        this.setCurrentVersion(target);
      });
    } catch (e) {
      this.loadRegistry();
      throw e;
    }
  }

  /** Re-apply forward ops current+1..N (only meaningful before truncation). */
  rollForwardTo(target: number): void {
    const cur = this.currentVersion();
    const head = this.headVersion();
    if (target <= cur || target > head)
      throw new ClayError("E_VALIDATION", `cannot roll forward from ${cur} to ${target} (head ${head})`);
    try {
      this.driver.tx(() => {
        for (let v = cur + 1; v <= target; v++) {
          const entry = this.getEntry(v);
          if (entry.migration)
            applyForwardOps(this.driver, this.reg, entry.migration.operations);
        }
        this.persistRegistry(target);
        this.setCurrentVersion(target);
      });
    } catch (e) {
      this.loadRegistry();
      throw e;
    }
  }

  // ---------- rows ----------
  insert(table: string, row: Record<string, unknown>): QueryRow {
    const t = getTable(this.reg, table);
    const { cols, vals } = validateInsert(t, row);
    const id = uuidv7();
    const now = nowIso();
    const allCols = ["id", "created_at", "updated_at", ...cols];
    const allVals: SqlValue[] = [id, now, now, ...vals];
    this.driver.exec(
      `INSERT INTO ${qid(table)} (${allCols.map(qid).join(", ")})
       VALUES (${allCols.map(() => "?").join(", ")})`, allVals);
    return this.rowById(table, id);
  }

  update(table: string, id: string, patch: Record<string, unknown>): QueryRow {
    const t = getTable(this.reg, table);
    this.mustExist(table, id);
    const { cols, vals } = validatePatch(t, patch);
    this.driver.exec(
      `UPDATE ${qid(table)} SET ${cols.map(c => `${qid(c)} = ?`).join(", ")},
         "updated_at" = ? WHERE "id" = ?`,
      [...vals, nowIso(), id]);
    return this.rowById(table, id);
  }

  softDelete(table: string, id: string): void {
    getTable(this.reg, table);
    this.mustExist(table, id);
    this.driver.exec(
      `UPDATE ${qid(table)} SET "deleted_at" = ?, "updated_at" = ? WHERE "id" = ?`,
      [nowIso(), nowIso(), id]);
  }

  query(q: QueryT, now: Date = new Date()): QueryRow[] {
    return runQuery(this.driver, this.reg, q, now);
  }

  private mustExist(table: string, id: string): void {
    const rows = this.driver.select(
      `SELECT "id" FROM ${qid(table)} WHERE "id" = ?`, [id]);
    if (rows.length === 0)
      throw new ClayError("E_VALIDATION", `no row '${id}' in '${table}'`);
  }

  private rowById(table: string, id: string): QueryRow {
    const rows = runQuery(this.driver, this.reg,
      { from: table, where: [{ field: "id", op: "eq", value: id }], includeDeleted: true });
    const row = rows[0];
    if (!row) throw new ClayError("E_INTERNAL", "row vanished after write");
    return row;
  }

  /** Raw physical dump, ordered by id — bit-equality checks (PB1, spine). */
  dumpTable(table: string): SqlRow[] {
    getTable(this.reg, table);
    return this.driver.select(`SELECT * FROM ${qid(table)} ORDER BY "id"`);
  }
}
