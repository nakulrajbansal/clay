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

export type PanelBlobInput = {
  panel_id: string;
  title: string;
  placement: { region: "top" | "main" | "side"; order: number };
  code: string;
  declared_queries: QueryT[];
  declared_writes: string[];
};

export type LivePanel = PanelBlobInput & { version: number };

export type CommitInput = {
  intent: string;
  summary: string;
  migration: MigrationPlanT | null;
  panels?: PanelBlobInput[];
  removePanels?: string[];
  diff?: unknown;
};

/** G16/I4: rewrite field references in a declared query after a rename. */
function renameQueryFields(q: QueryT, table: string, from: string, to: string): QueryT {
  if (q.from !== table) return q;
  const field = (f: string): string => (f === from ? to : f);
  const out: QueryT = { ...q };
  if (out.select) out.select = out.select.map(field);
  if (out.where) out.where = out.where.map(c => ({ ...c, field: field(c.field) }));
  if (out.orWhere) out.orWhere = out.orWhere.map(g => g.map(c => ({ ...c, field: field(c.field) })));
  if (out.orderBy) out.orderBy = out.orderBy.map(o => ({ ...o, field: field(o.field) }));
  if (out.groupBy) out.groupBy = out.groupBy.map(field);
  if (out.aggregate) out.aggregate = out.aggregate.map(a => ({ ...a, field: field(a.field) }));
  return out;
}

export type VersionEntry = {
  version: number;
  parent: number;
  created_at: string;
  intent_text: string;
  summary: string;
  migration: MigrationPlanT | null;
};

export type HistoryEntry = Omit<VersionEntry, "migration">;

const qid = (name: string): string => `"${name}"`;

export class ClayStore {
  private reg: Registry = new Map();

  private constructor(private readonly driver: DbDriver) {}

  static async openMemory(): Promise<ClayStore> {
    return ClayStore.fromDriver(await openMemoryDriver());
  }

  /** Bind a store to an already-open driver (browser worker, imports). */
  static fromDriver(driver: DbDriver): ClayStore {
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
    const v = this.getSetting<number>("current_version");
    return v === undefined ? this.headVersion() : v;
  }

  private setCurrentVersion(v: number): void {
    this.setSetting("current_version", v);
  }

  // ---------- settings (doc 04 §3: mode, byo key, sample markers, …) ----------
  getSetting<T>(key: string): T | undefined {
    const rows = this.driver.select(
      "SELECT value_json FROM sys.settings WHERE key = ?", [key]);
    const raw = rows[0]?.value_json;
    return raw === undefined ? undefined : JSON.parse(String(raw)) as T;
  }

  setSetting(key: string, value: unknown): void {
    this.driver.exec(
      `INSERT INTO sys.settings(key, value_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      [key, JSON.stringify(value)]);
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

  /** Commit a mutation: validate, migrate, write panel blobs/tombstones,
   * persist registry, append log — one transaction (doc 04 §4). */
  commit(input: CommitInput): number {
    const head = this.headVersion();
    if (this.currentVersion() !== head)
      throw new ClayError("E_VALIDATION",
        "store is rolled back (scrub preview); roll forward or truncate first");
    try {
      return this.driver.tx(() => {
        // capture the pre-commit manifest for the G16 rename rewrite
        const untouched = this.livePanels().filter(p =>
          !(input.panels ?? []).some(np => np.panel_id === p.panel_id)
          && !(input.removePanels ?? []).includes(p.panel_id));

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

        for (const p of input.panels ?? []) this.writePanelBlob(version, p);
        for (const id of input.removePanels ?? [])
          this.driver.exec(
            "INSERT INTO sys.panel_tombstones(version, panel_id) VALUES (?, ?)",
            [version, id]);

        // G16: untouched panels whose declared queries reference renamed
        // columns get a rewritten blob at this version. (Query literals
        // inside code are rewritten at the Bridge via the same map — the
        // static rewrite of code text is tracked as OPEN-QUESTIONS Q18.)
        const renames = (input.migration?.operations ?? [])
          .filter(o => o.op === "rename_column");
        if (renames.length > 0) {
          for (const lp of untouched) {
            let queries = lp.declared_queries;
            for (const r of renames)
              queries = queries.map(q => renameQueryFields(q, r.table, r.from, r.to));
            if (JSON.stringify(queries) !== JSON.stringify(lp.declared_queries))
              this.writePanelBlob(version, { ...lp, declared_queries: queries });
          }
        }

        this.setCurrentVersion(version);
        return version;
      });
    } catch (e) {
      this.loadRegistry();   // in-memory registry may be ahead of the rolled-back tx
      throw e;
    }
  }

  private writePanelBlob(version: number, p: PanelBlobInput): void {
    this.driver.exec(
      `INSERT OR REPLACE INTO sys.panel_blobs(version, panel_id, code,
         placement_json, declared_q_json) VALUES (?, ?, ?, ?, ?)`,
      [version, p.panel_id, p.code, JSON.stringify(p.placement),
       JSON.stringify({
         title: p.title,
         declared_queries: p.declared_queries,
         declared_writes: p.declared_writes,   // ADR-014 rides in the manifest json
       })]);
  }

  /** Live panels at a version (default: current): latest blob per id, minus
   * panels whose latest tombstone is newer than their latest blob
   * (doc 04 §5). Passing an older version powers scrub-preview — panels AT
   * K rendered against CURRENT data, no inverses run (doc 02 §6). */
  livePanels(at?: number): LivePanel[] {
    const v = at ?? this.currentVersion();
    const rows = this.driver.select(
      `SELECT b.panel_id, b.version, b.code, b.placement_json, b.declared_q_json
       FROM sys.panel_blobs b
       JOIN (SELECT panel_id, MAX(version) AS mv FROM sys.panel_blobs
             WHERE version <= ? GROUP BY panel_id) m
         ON b.panel_id = m.panel_id AND b.version = m.mv
       ORDER BY b.panel_id`, [v, ]);
    const out: LivePanel[] = [];
    for (const r of rows) {
      const tomb = this.driver.select(
        `SELECT MAX(version) AS tv FROM sys.panel_tombstones
         WHERE panel_id = ? AND version <= ?`, [String(r.panel_id), v]);
      const tv = tomb[0]?.tv;
      if (tv !== null && tv !== undefined && Number(tv) >= Number(r.version)) continue;
      const manifest = JSON.parse(String(r.declared_q_json)) as {
        title: string; declared_queries: QueryT[]; declared_writes: string[];
      };
      out.push({
        panel_id: String(r.panel_id), version: Number(r.version),
        code: String(r.code),
        placement: JSON.parse(String(r.placement_json)) as LivePanel["placement"],
        title: manifest.title,
        declared_queries: manifest.declared_queries,
        declared_writes: manifest.declared_writes ?? [],
      });
    }
    return out;
  }

  /** The full linear chain, oldest first (history view / time slider). */
  history(): HistoryEntry[] {
    return this.driver.select(
      `SELECT version, parent, created_at, intent_text, summary
       FROM sys.version_log ORDER BY version`).map(r => ({
      version: Number(r.version), parent: Number(r.parent),
      created_at: String(r.created_at), intent_text: String(r.intent_text),
      summary: String(r.summary),
    }));
  }

  /** Last n commit summaries, newest first (S1 context, doc 05 §1). */
  recentSummaries(n: number): string[] {
    return this.driver
      .select("SELECT summary FROM sys.version_log ORDER BY version DESC LIMIT ?", [n])
      .map(r => String(r.summary));
  }

  // ---------- attempts (S0/doc 05 §5 analytics) ----------
  beginAttempt(intent: string): string {
    const id = uuidv7();
    this.driver.exec(
      "INSERT INTO sys.attempts(id, at, intent_text, outcome, error_code) VALUES (?, ?, ?, 'pending', NULL)",
      [id, nowIso(), intent]);
    return id;
  }

  finishAttempt(id: string, outcome: string, errorCode: string | null = null): void {
    this.driver.exec(
      "UPDATE sys.attempts SET outcome = ?, error_code = ? WHERE id = ?",
      [outcome, errorCode, id]);
  }

  /** Independent full copy for the S4 shadow dry-run (doc 05 §1). */
  async shadowCopy(): Promise<ClayStore> {
    const copy = new ClayStore(await this.driver.snapshot());
    copy.loadRegistry();
    return copy;
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
        if (opts.truncate) {
          this.driver.exec("DELETE FROM sys.version_log WHERE version > ?", [target]);
          this.driver.exec("DELETE FROM sys.panel_blobs WHERE version > ?", [target]);
          this.driver.exec("DELETE FROM sys.panel_tombstones WHERE version > ?", [target]);
        }
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
