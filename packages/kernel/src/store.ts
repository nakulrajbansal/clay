// ClayStore: the trusted facade over user.db + system.db. Commits span
// DDL + backfills + registry update + version_log append in ONE
// transaction (doc 04 §4). Versioning is a linear chain (doc 04 §5):
// rollback applies inverses; roll-forward (pre-truncation) re-applies
// forward ops; truncation is the only destructive-ish operation (ADR-007).
import { ClayError } from "./errors";
import {
  copyDatabase, createSystemTables, openDriverFromBytes, openMemoryDriver,
  type DbDriver, type SqlRow, type SqlValue,
} from "./db";
import { zipRead, zipWrite } from "./zip";
import { validateMutationPlan } from "./validate";
import {
  cloneRegistry, getTable, type Registry, type RegTable,
} from "./registry";
import { nowIso, uuidv7, validateInsert, validatePatch } from "./rows";
import {
  applyForwardOps, applyInverseOps, validateMigrationPlan,
  type MigrationPlanT,
} from "./migrate";
import { runQuery, type QueryRow } from "./query";
import { Observer, type Suggestion, type UsageEvent } from "./observe";

type QueryT = import("@clay/schema").Query;

export type PanelBlobInput = {
  panel_id: string;
  title: string;
  placement: { region: "top" | "main" | "side"; order: number; w?: number };
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
  readonly observer: Observer;

  private constructor(private readonly driver: DbDriver) {
    this.observer = new Observer(driver);
  }

  static async openMemory(): Promise<ClayStore> {
    return ClayStore.fromDriver(await openMemoryDriver());
  }

  /** Bind a store to an already-open driver (browser worker, imports). */
  static fromDriver(driver: DbDriver): ClayStore {
    createSystemTables(driver);
    // G6: row-level undo lives in user.db so it travels with exports.
    driver.exec(`CREATE TABLE IF NOT EXISTS "row_history"(
      "id" TEXT PRIMARY KEY, "table" TEXT NOT NULL, "row_id" TEXT NOT NULL,
      "at" TEXT NOT NULL, "before_json" TEXT NOT NULL)`);
    const store = new ClayStore(driver);
    store.loadRegistry();
    return store;
  }

  /** G6 ring cap; public so tests can lower it. */
  rowHistoryCap = 10_000;

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
        const preLive = this.livePanels();
        const untouched = preLive.filter(p =>
          !(input.panels ?? []).some(np => np.panel_id === p.panel_id)
          && !(input.removePanels ?? []).includes(p.panel_id));
        // Layout width (ADR-017) is a direct-manipulation concern; a model
        // reshape re-emits placement WITHOUT w, so preserve the panel's
        // existing span unless the plan explicitly sets one.
        const priorW = new Map(preLive.map(p => [p.panel_id, p.placement.w]));

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

        for (const p of input.panels ?? []) {
          const w = p.placement.w ?? priorW.get(p.panel_id);
          const merged = w && w !== 1
            ? { ...p, placement: { ...p.placement, w } }
            : p;
          this.writePanelBlob(version, merged);
        }
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

  /**
   * Direct manipulation (B4/doc 13): apply new panel placements as a
   * reversible commit — no model, no migration. Only the moved panels are
   * re-committed (code and queries unchanged), so it's a normal version in
   * the log and fully rewindable via the time slider. Reshape by touch and
   * reshape by language share one history.
   */
  commitLayout(
    placements: { panel_id: string; region: "top" | "main" | "side"; order: number; w?: number }[],
  ): number {
    const live = new Map(this.livePanels().map(p => [p.panel_id, p]));
    const moved: PanelBlobInput[] = [];
    for (const pl of placements) {
      const p = live.get(pl.panel_id);
      if (!p) continue;
      // width defaults to the panel's current span (preserved across reorder)
      const w = pl.w ?? p.placement.w ?? 1;
      const curW = p.placement.w ?? 1;
      if (p.placement.region === pl.region && p.placement.order === pl.order && curW === w) continue;
      moved.push({
        panel_id: p.panel_id, title: p.title,
        placement: { region: pl.region, order: pl.order, ...(w !== 1 ? { w } : {}) },
        code: p.code, declared_queries: p.declared_queries, declared_writes: p.declared_writes,
      });
    }
    if (moved.length === 0) return this.headVersion();
    return this.commit({
      intent: "rearrange layout",
      summary: "Rearranged the layout by hand.",
      migration: null, panels: moved,
      diff: moved.map(p => ({
        kind: "change_panel",
        detail: `Moved ${p.title} to ${p.placement.region}`,
      })),
    });
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
    this.observer.record({ kind: "insert", subject: table });
    return this.rowById(table, id);
  }

  // ---------- Observer (doc 02 §1) ----------
  recordUsage(ev: UsageEvent): void { this.observer.record(ev); }
  suggestions(): Suggestion[] {
    // tables that already have at least one panel — so "table with data but
    // no view" can be offered (ambient reshaping, B3).
    const viewed = new Set<string>();
    const boarded = new Set<string>();          // tables already shown as a board
    for (const p of this.livePanels()) {
      const isBoard = /\bBoard\b/.test(p.code ?? "");
      for (const q of p.declared_queries) {
        viewed.add(q.from);
        if (isBoard) boarded.add(q.from);
      }
    }
    return this.observer.suggestions(this.reg, viewed, boarded);
  }
  markSuggestionShown(subject: string, kind: string): void {
    this.observer.markShown(subject, kind);
  }
  dismissSuggestion(subject: string, kind: string): void {
    this.observer.dismiss(subject, kind);
  }
  acceptSuggestion(subject: string, kind: string): void {
    this.observer.accept(subject, kind);
  }

  /** G6: snapshot the raw row before every update/softDelete. */
  private writeRowHistory(table: string, id: string): void {
    const rows = this.driver.select(
      `SELECT * FROM ${qid(table)} WHERE "id" = ?`, [id]);
    if (!rows[0]) return;
    this.driver.exec(
      `INSERT INTO "row_history"("id", "table", "row_id", "at", "before_json")
       VALUES (?, ?, ?, ?, ?)`,
      [uuidv7(), table, id, nowIso(), JSON.stringify(rows[0])]);
    const n = Number(this.driver.select(
      `SELECT COUNT(*) AS n FROM "row_history"`)[0]?.n ?? 0);
    if (n > this.rowHistoryCap) {
      this.driver.exec(
        `DELETE FROM "row_history" WHERE "id" IN (
           SELECT "id" FROM "row_history" ORDER BY "at" ASC LIMIT ?)`,
        [n - this.rowHistoryCap]);
    }
  }

  rowHistoryCount(): number {
    return Number(this.driver.select(
      `SELECT COUNT(*) AS n FROM "row_history"`)[0]?.n ?? 0);
  }

  /** Local attempt stats for Settings (doc 05 §5). No network. */
  attemptStats(): { kept: number; discarded: number; failed: number; clarify: number } {
    const rows = this.driver.select(
      `SELECT outcome, COUNT(*) AS n FROM sys.attempts GROUP BY outcome`);
    const by = (o: string): number =>
      Number(rows.find(r => r.outcome === o)?.n ?? 0);
    return { kept: by("kept"), discarded: by("discarded"),
      failed: by("failed"), clarify: by("clarify") };
  }

  /** Rows with a snapshot in the restore window (G6: last 30 days). */
  restorableRows(table: string, sinceDays = 30): string[] {
    getTable(this.reg, table);
    const cutoff = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
    return this.driver.select(
      `SELECT DISTINCT "row_id" FROM "row_history" WHERE "table" = ? AND "at" >= ?`,
      [table, cutoff]).map(r => String(r.row_id));
  }

  /** Restore the most recent snapshot of a row (also undeletes, since the
   * snapshot carries deleted_at). Columns that no longer exist are skipped
   * — a projection, not a loss (doc 04 §5 spirit). */
  restoreRow(table: string, id: string): QueryRow {
    const t = getTable(this.reg, table);
    const entry = this.driver.select(
      `SELECT "before_json" FROM "row_history"
       WHERE "table" = ? AND "row_id" = ? ORDER BY "at" DESC LIMIT 1`,
      [table, id])[0];
    if (!entry)
      throw new ClayError("E_VALIDATION", `no history for '${table}/${id}'`);
    this.mustExist(table, id);
    const before = JSON.parse(String(entry.before_json)) as Record<string, SqlValue>;
    const settable = new Set([
      ...t.columns.filter(c => c.type !== "computed").map(c => c.name),
      "deleted_at",
    ]);
    const cols = Object.keys(before).filter(k => settable.has(k));
    if (cols.length > 0) {
      this.writeRowHistory(table, id);   // restoring is itself undoable
      this.driver.exec(
        `UPDATE ${qid(table)} SET ${cols.map(c => `${qid(c)} = ?`).join(", ")},
           "updated_at" = ? WHERE "id" = ?`,
        [...cols.map(c => before[c] ?? null), nowIso(), id]);
    }
    return this.rowById(table, id);
  }

  update(table: string, id: string, patch: Record<string, unknown>): QueryRow {
    const t = getTable(this.reg, table);
    this.mustExist(table, id);
    this.writeRowHistory(table, id);
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
    this.writeRowHistory(table, id);
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

  /** Panel-scoped revert (doc 05 §7): restore the PREVIOUS blob of one
   * panel as a NEW commit — linear history preserved, nothing truncated. */
  revertPanel(panelId: string): number {
    const current = this.livePanels().find(p => p.panel_id === panelId);
    if (!current)
      throw new ClayError("E_VALIDATION", `no live panel '${panelId}'`);
    const rows = this.driver.select(
      `SELECT version, code, placement_json, declared_q_json FROM sys.panel_blobs
       WHERE panel_id = ? AND version < ? ORDER BY version DESC LIMIT 1`,
      [panelId, current.version]);
    const prev = rows[0];
    if (!prev)
      throw new ClayError("E_VALIDATION",
        `'${panelId}' has no earlier version to roll back to`);
    const manifest = JSON.parse(String(prev.declared_q_json)) as {
      title: string; declared_queries: QueryT[]; declared_writes?: string[];
    };
    return this.commit({
      intent: `roll back panel ${panelId}`,
      summary: `Rolls back the ${manifest.title} panel to its previous version.`,
      migration: null,
      panels: [{
        panel_id: panelId, title: manifest.title,
        placement: JSON.parse(String(prev.placement_json)) as LivePanel["placement"],
        code: String(prev.code),
        declared_queries: manifest.declared_queries,
        declared_writes: manifest.declared_writes ?? [],
      }],
      diff: [{ kind: "change_panel", detail: `${manifest.title} rolled back` }],
    });
  }

  /** Raw physical dump, ordered by id — bit-equality checks (PB1, spine). */
  dumpTable(table: string): SqlRow[] {
    getTable(this.reg, table);
    return this.driver.select(`SELECT * FROM ${qid(table)} ORDER BY "id"`);
  }

  // ---------- .clay archives (doc 04 §7) ----------
  /** zip{ manifest.json, user.db, system.db } — the backup story and a
   * trust artifact: the whole app in one file. */
  async exportArchive(appName: string): Promise<Uint8Array> {
    const { user, system } = await this.driver.exportDatabases();
    const manifest: ClayManifest = {
      format: 1, app: appName, exported_at: nowIso(),
      tables: this.reg.size, versions: this.headVersion(),
    };
    return zipWrite([
      { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) },
      { name: "user.db", data: user },
      { name: "system.db", data: system },
    ]);
  }

  static parseArchive(bytes: Uint8Array): {
    manifest: ClayManifest; user: Uint8Array; system: Uint8Array;
  } {
    const entries = zipRead(bytes);
    const get = (name: string): Uint8Array => {
      const e = entries.find(x => x.name === name);
      if (!e) throw new ClayError("E_VALIDATION", `archive is missing ${name}`);
      return e.data;
    };
    const manifest = JSON.parse(new TextDecoder().decode(get("manifest.json"))) as ClayManifest;
    if (manifest.format !== 1)
      throw new ClayError("E_VALIDATION",
        `unsupported archive format ${String(manifest.format)}`);
    return { manifest, user: get("user.db"), system: get("system.db") };
  }

  /** Integrity checks run on an import staging store (doc 04 §7). */
  verifyIntegrity(): string[] {
    const issues: string[] = [];
    for (const t of this.reg.values()) {
      const info = this.driver.select(`PRAGMA main.table_info(${qid(t.name)})`);
      const physical = new Set(info.map(r => String(r.name)));
      if (physical.size === 0) { issues.push(`table '${t.name}' is missing`); continue; }
      for (const col of ["id", "created_at", "updated_at", "deleted_at"])
        if (!physical.has(col)) issues.push(`'${t.name}' lacks kernel column '${col}'`);
      for (const c of t.columns)
        if (c.type !== "computed" && !physical.has(c.name))
          issues.push(`'${t.name}' lacks registered column '${c.name}'`);
    }
    const chain = this.history();
    chain.forEach((e, i) => {
      if (e.version !== i + 1 || e.parent !== i)
        issues.push(`version chain broken at v${e.version}`);
    });
    try { this.livePanels(); }
    catch (e) { issues.push(`panel manifest unreadable: ${String(e)}`); }
    return issues;
  }

  /**
   * Import an archive: stage in memory, run integrity checks (abort on
   * failure — the live app is untouched), re-validate every live panel
   * blob (G15: never execute unvalidated blobs, regardless of provenance),
   * then swap. With `openFresh` the staged content is copied into a fresh
   * (persistent) driver; without it the staging store IS the result.
   */
  static async importArchive(
    bytes: Uint8Array,
    openFresh?: () => Promise<DbDriver>,
  ): Promise<{ store: ClayStore; manifest: ClayManifest; invalidPanels: string[] }> {
    const { manifest, user, system } = ClayStore.parseArchive(bytes);
    const staging = ClayStore.fromDriver(await openDriverFromBytes(user, system));
    try {
      const issues = staging.verifyIntegrity();
      if (issues.length > 0)
        throw new ClayError("E_VALIDATION",
          `archive failed integrity checks: ${issues.join("; ")}`, issues);

      const invalidPanels: string[] = [];
      for (const panel of staging.livePanels()) {
        const problems = validateMutationPlan({
          api: 1, summary: "Imported panel.",
          user_facing_diff: [{ kind: "add_panel", detail: panel.panel_id }],
          clarifying_question: null, assumptions: [], migration: null,
          panels: [{
            panel_id: panel.panel_id, title: panel.title,
            placement: panel.placement, code: panel.code,
            declared_queries: panel.declared_queries,
            declared_writes: panel.declared_writes,
          }],
          remove_panels: [], confidence: 1,
        }, { registry: staging.registrySnapshot(), livePanelIds: [] });
        if (problems.length > 0) invalidPanels.push(panel.panel_id);
      }

      if (!openFresh) return { store: staging, manifest, invalidPanels };
      const fresh = await openFresh();
      copyDatabase(staging.driver, fresh);
      staging.close();
      return { store: ClayStore.fromDriver(fresh), manifest, invalidPanels };
    } catch (e) {
      staging.close();
      throw e;
    }
  }
}

export type ClayManifest = {
  format: 1;
  app: string;
  exported_at: string;
  tables: number;
  versions: number;
};
