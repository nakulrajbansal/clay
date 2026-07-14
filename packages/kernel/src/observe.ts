// Observer (doc 02 §1, G5-adjacent): usage_events -> heuristics ->
// suggestions. The model is for semantics; the Observer just NOTICES
// patterns and offers a pre-filled intent the user can accept or dismiss.
// Two W4 heuristics: token-promotion (a free-text column whose values
// repeat wants to be a status enum) and repeated-filter (the same filter
// event fired often wants a pinned filtered panel).
import type { DbDriver } from "./db";
import { nowIso, uuidv7 } from "./rows";
import { getTable, type Registry } from "./registry";

export type UsageEvent = {
  kind: "insert" | "update" | "filter" | "view";
  subject: string;                 // "table.column" or "panel_id" or event name
  detail?: Record<string, unknown>;
};

export type Suggestion = {
  id: string;
  kind: "promote_to_status" | "pin_filtered_panel" | "add_view"
    | "flag_overdue" | "regroup_board";
  subject: string;
  /** the intent text prefilled into the rail if accepted */
  intent: string;
  /** human explanation shown on the chip */
  reason: string;
};

const USAGE_CAP = 50_000;          // ring buffer (doc 04 §3)
const MAX_SUGGESTIONS = 4;         // don't wall the rail with chips
// Statuses that mean "no longer outstanding" — a past date on one of these
// isn't overdue. Lowercased match.
// Only genuinely-settled statuses count as terminal — a "sent" but unpaid
// invoice can still be overdue, so it must NOT be here.
const TERMINAL_STATUS = new Set([
  "done", "paid", "closed", "complete", "completed", "finished", "resolved",
  "cancelled", "canceled", "archived", "delivered", "won",
]);

export class Observer {
  constructor(private readonly driver: DbDriver) {}

  record(ev: UsageEvent): void {
    this.driver.exec(
      `INSERT INTO sys.usage_events(id, at, kind, subject, detail_json)
       VALUES (?, ?, ?, ?, ?)`,
      [uuidv7(), nowIso(), ev.kind, ev.subject,
       ev.detail ? JSON.stringify(ev.detail) : null]);
    const n = Number(this.driver.select(
      `SELECT COUNT(*) AS n FROM sys.usage_events`)[0]?.n ?? 0);
    if (n > USAGE_CAP)
      this.driver.exec(
        `DELETE FROM sys.usage_events WHERE id IN (
           SELECT id FROM sys.usage_events ORDER BY at ASC LIMIT ?)`,
        [n - USAGE_CAP]);
  }

  /** Suggestions not yet shown/accepted/dismissed, freshly derived.
   * `viewedTables` = tables that already have at least one panel; a table
   * with data but no view is the strongest ambient prompt. */
  suggestions(
    reg: Registry,
    viewedTables: Set<string> = new Set(),
    boardedTables: Set<string> = new Set(),
  ): Suggestion[] {
    const out: Suggestion[] = [];
    out.push(...this.unviewedTable(reg, viewedTables));
    out.push(...this.overdueItems(reg));
    out.push(...this.statusNotBoarded(reg, viewedTables, boardedTables));
    out.push(...this.tokenPromotion(reg));
    out.push(...this.repeatedFilter());
    // suppress any the user already dismissed/accepted
    const seen = new Set(this.driver
      .select(`SELECT subject, kind FROM sys.suggestions WHERE state != 'shown'`)
      .map(r => `${String(r.kind)}:${String(r.subject)}`));
    return out.filter(s => !seen.has(`${s.kind}:${s.subject}`)).slice(0, MAX_SUGGESTIONS);
  }

  /**
   * Overdue: a table with a date column and a status enum, where rows sit in
   * the past on a non-terminal status. The app noticing "these are late" and
   * offering to surface them is ambient reshaping at its most perceptive.
   */
  private overdueItems(reg: Registry): Suggestion[] {
    const out: Suggestion[] = [];
    const today = nowIso().slice(0, 10);
    for (const table of reg.values()) {
      const dateCol = table.columns.find(c => c.type === "date" && !c.hidden);
      const statusCol = table.columns.find(c => c.type === "enum" && !c.hidden);
      if (!dateCol || !statusCol) continue;
      let rows;
      try {
        rows = this.driver.select(
          `SELECT "${statusCol.name}" AS s, COUNT(*) AS n FROM "${table.name}"
           WHERE "deleted_at" IS NULL AND "${dateCol.name}" IS NOT NULL
             AND substr("${dateCol.name}", 1, 10) < ?
           GROUP BY "${statusCol.name}"`, [today]);
      } catch { continue; }
      const late = rows.filter(r => !TERMINAL_STATUS.has(String(r.s).toLowerCase()));
      const n = late.reduce((sum, r) => sum + Number(r.n), 0);
      if (n < 2) continue;
      out.push({
        id: uuidv7(), kind: "flag_overdue", subject: table.name,
        intent: `add a view of ${table.name} that are overdue — past their `
          + `${dateCol.name} and not yet done — highlighted so they stand out`,
        reason: `${n} ${table.name} are overdue and still open — surface the overdue ones?`,
      });
    }
    return out;
  }

  /**
   * Status-not-boarded: a table you already see (as a list) that has a status
   * enum but no board — the classic "these want to be a kanban" nudge.
   */
  private statusNotBoarded(
    reg: Registry, viewed: Set<string>, boarded: Set<string>,
  ): Suggestion[] {
    const out: Suggestion[] = [];
    for (const table of reg.values()) {
      if (!viewed.has(table.name) || boarded.has(table.name)) continue;
      const statusCol = table.columns.find(c => c.type === "enum" && !c.hidden);
      if (!statusCol) continue;
      let n = 0;
      try {
        n = Number(this.driver.select(
          `SELECT COUNT(*) AS n FROM "${table.name}" WHERE "deleted_at" IS NULL`)[0]?.n ?? 0);
      } catch { continue; }
      if (n < 3) continue;
      out.push({
        id: uuidv7(), kind: "regroup_board", subject: `${table.name}.${statusCol.name}`,
        intent: `show my ${table.name} as a board grouped by ${statusCol.name}`,
        reason: `your ${table.name} have a ${statusCol.name} field but you only see a list — view them as a board?`,
      });
    }
    return out;
  }

  /**
   * Unviewed-table: a table holding real data but rendered by NO panel is
   * data the user can't see — offer to build a view. The clearest ambient
   * reshape: the app notices and meets you halfway.
   */
  private unviewedTable(reg: Registry, viewed: Set<string>): Suggestion[] {
    const out: Suggestion[] = [];
    for (const table of reg.values()) {
      if (viewed.has(table.name)) continue;
      let n = 0;
      try {
        n = Number(this.driver.select(
          `SELECT COUNT(*) AS n FROM "${table.name}" WHERE "deleted_at" IS NULL`)[0]?.n ?? 0);
      } catch { continue; }
      if (n < 3) continue;
      const hasStatus = table.columns.some(c => c.type === "enum" && !c.hidden);
      out.push({
        id: uuidv7(), kind: "add_view", subject: table.name,
        intent: hasStatus
          ? `show my ${table.name} as a board grouped by status, and a table`
          : `add a table view of my ${table.name}`,
        reason: `You have ${n} ${table.name} but nothing shows them yet — add a view?`,
      });
    }
    return out;
  }

  /**
   * Token-promotion: a free-text column on a table with enough rows whose
   * DISTINCT values are few relative to the row count reads like a status.
   * Uses stored data shape (not usage events) — a structural signal.
   */
  private tokenPromotion(reg: Registry): Suggestion[] {
    const out: Suggestion[] = [];
    for (const table of reg.values()) {
      let total = 0;
      try {
        total = Number(this.driver.select(
          `SELECT COUNT(*) AS n FROM "${table.name}" WHERE "deleted_at" IS NULL`)[0]?.n ?? 0);
      } catch { continue; }
      if (total < 6) continue;
      for (const col of table.columns) {
        if (col.type !== "text" || col.hidden) continue;
        const rows = this.driver.select(
          `SELECT "${col.name}" AS v, COUNT(*) AS n FROM "${table.name}"
           WHERE "deleted_at" IS NULL AND "${col.name}" IS NOT NULL
           GROUP BY "${col.name}"`);
        const distinct = rows.length;
        const filled = rows.reduce((s, r) => s + Number(r.n), 0);
        if (filled < 6 || distinct < 2 || distinct > 6) continue;
        // most values must recur (a real category, not free notes)
        const repeats = rows.filter(r => Number(r.n) >= 2).length;
        if (repeats < distinct * 0.6) continue;
        const values = rows.map(r => String(r.v)).slice(0, 6);
        out.push({
          id: uuidv7(), kind: "promote_to_status",
          subject: `${table.name}.${col.name}`,
          intent: `turn the ${col.name} field into a status with a colored badge`,
          reason: `"${col.name}" keeps reusing a few values (${values.join(", ")}) — make it a real status?`,
        });
      }
    }
    return out;
  }

  /**
   * Repeated-filter: the same filter event fired many times suggests the
   * user keeps narrowing to one slice — offer a pinned filtered panel.
   */
  private repeatedFilter(): Suggestion[] {
    const rows = this.driver.select(
      `SELECT subject, detail_json, COUNT(*) AS n FROM sys.usage_events
       WHERE kind = 'filter'
       GROUP BY subject, detail_json HAVING n >= 3
       ORDER BY n DESC LIMIT 3`);
    return rows.map(r => {
      const detail = r.detail_json ? JSON.parse(String(r.detail_json)) as Record<string, unknown> : {};
      const parts = Object.entries(detail)
        .filter(([, v]) => v !== "" && v != null)
        .map(([k, v]) => `${k} is ${String(v)}`);
      const clause = parts.length ? parts.join(" and ") : String(r.subject);
      return {
        id: uuidv7(), kind: "pin_filtered_panel" as const,
        subject: `${String(r.subject)}:${String(r.detail_json)}`,
        intent: `add a pinned panel showing only rows where ${clause}`,
        reason: `you've filtered to "${clause}" ${String(r.n)} times — pin it as its own panel?`,
      };
    });
  }

  markShown(subject: string, kind: string): void {
    this.setState(subject, kind, "shown");
  }
  accept(subject: string, kind: string): void {
    this.setState(subject, kind, "accepted");
  }
  dismiss(subject: string, kind: string): void {
    this.setState(subject, kind, "dismissed");
  }

  private setState(subject: string, kind: string, state: string): void {
    this.driver.exec(
      `INSERT INTO sys.suggestions(id, kind, subject, state, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [uuidv7(), kind, subject, state, nowIso()]);
  }
}

/** Convenience for pipeline/store wiring: does this table exist? */
export function tableExists(reg: Registry, name: string): boolean {
  try { getTable(reg, name); return true; } catch { return false; }
}
