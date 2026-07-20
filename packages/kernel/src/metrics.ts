// Post-launch instrumentation (build-plan doc 09 "Post-launch instrumentation").
//
// Watches the pipeline's existing DebugEvent stream and derives the four
// metrics the build plan calls out for the first 30 days:
//   - first-pass commit rate by diff kind (did it reach preview with NO repair?)
//   - validator-rejection reasons (the v1.1 vocabulary roadmap)
//   - clarify rate
//   - (foundation for) day-14 mutation retention
//
// This is a pure OBSERVER. It never touches the reshape loop, the store, or
// any commit path: it only consumes DebugEvent and aggregates counts. Nothing
// here is on the critical path, so it cannot alter a mutation outcome.
//
// Privacy: it records intents only as a length + a coarse diff-kind label,
// never the raw text or any row data (doc 01 principle: data outlives
// interface; the kernel is untrusted with content it does not need).

import type { DebugEvent } from "./pipeline";

/** Coarse classification of what an attempt tried to do, from its first
 * validate/plan signal. Kept small on purpose; refine behind an ADR. */
export type DiffKind =
  | "add_field"
  | "add_panel"
  | "remove_panel"
  | "restyle"
  | "chart"
  | "other";

export type Outcome = "committed" | "preview" | "clarify" | "failed";

export type AttemptRecord = {
  intentLength: number;
  diffKind: DiffKind;
  repaired: boolean;            // did it need the single repair round?
  outcome: Outcome;
  failStage?: string;           // plan | validate | dry_run
  validatorRules: string[];     // e.g. ["V4", "V1"] when a validate step fired
};

export type MetricsSummary = {
  attempts: number;
  /** reached preview/commit on the FIRST pass (no repair) over all attempts. */
  firstPassCommitRate: number;
  firstPassByDiffKind: Record<string, { firstPass: number; total: number; rate: number }>;
  clarifyRate: number;
  failRate: number;
  /** validator rule -> count, descending. The v1.1 vocabulary roadmap. */
  validatorRejections: Record<string, number>;
  /** fail stage -> count (plan | validate | dry_run). */
  failStages: Record<string, number>;
  repairRate: number;
};

const DIFF_RULES: ReadonlyArray<[RegExp, DiffKind]> = [
  [/\b(add|new)\b.*\b(field|column|property|attribute)\b/i, "add_field"],
  [/\b(remove|delete|drop)\b.*\bpanel\b/i, "remove_panel"],
  [/\b(add|new)\b.*\b(panel|view|card|list|table|form)\b/i, "add_panel"],
  [/\b(chart|graph|plot|trend|metric)\b/i, "chart"],
  [/\b(color|colou?r|badge|style|font|theme|highlight|bold)\b/i, "restyle"],
];

/** Best-effort diff-kind label from a raw intent string. */
export function classifyDiffKind(intent: string): DiffKind {
  for (const [re, kind] of DIFF_RULES) if (re.test(intent)) return kind;
  return "other";
}

const ruleOf = (issue: string): string | null => {
  const m = /^(V[1-7])\b/.exec(issue);
  return m ? m[1] : null;
};

/**
 * Collects pipeline DebugEvents into per-attempt records and a rollup.
 * Wire it in by passing `collector.onDebug` as the pipeline's onDebug (it
 * chains to any existing handler you pass through `tee`).
 */
export class MetricsCollector {
  private records: AttemptRecord[] = [];
  private cur: {
    intentLength: number; diffKind: DiffKind; repaired: boolean;
    validatorRules: Set<string>;
  } | null = null;

  constructor(private readonly tee?: (ev: DebugEvent) => void) {}

  /** Pass this as the pipeline's `onDebug`. */
  readonly onDebug = (ev: DebugEvent): void => {
    switch (ev.stage) {
      case "intake":
        this.cur = {
          intentLength: ev.intent.length,
          diffKind: classifyDiffKind(ev.intent),
          repaired: false,
          validatorRules: new Set<string>(),
        };
        break;
      case "repair":
        if (this.cur) this.cur.repaired = true;
        break;
      case "validate":
        if (this.cur) for (const s of ev.issues) {
          const r = ruleOf(s);
          if (r) this.cur.validatorRules.add(r);
        }
        break;
      case "outcome":
        if (this.cur) {
          const status = ev.status.startsWith("failed")
            ? "failed"
            : ev.status === "clarify" ? "clarify"
            : "preview";
          const failStage = ev.status.startsWith("failed@")
            ? ev.status.slice("failed@".length) : undefined;
          this.records.push({
            intentLength: this.cur.intentLength,
            diffKind: this.cur.diffKind,
            repaired: this.cur.repaired,
            outcome: status as Outcome,
            failStage,
            validatorRules: [...this.cur.validatorRules],
          });
          this.cur = null;
        }
        break;
    }
    this.tee?.(ev);
  };

  /** Mark the most recent preview attempt as committed (call from keep()). */
  markCommitted(): void {
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (this.records[i].outcome === "preview") { this.records[i].outcome = "committed"; return; }
    }
  }

  all(): ReadonlyArray<AttemptRecord> { return this.records; }
  reset(): void { this.records = []; this.cur = null; }

  summary(): MetricsSummary {
    const recs = this.records;
    const n = recs.length;
    const rate = (k: number): number => (n === 0 ? 0 : k / n);

    // "first pass" = reached preview OR committed with no repair round.
    const reachedPreview = (r: AttemptRecord): boolean =>
      r.outcome === "preview" || r.outcome === "committed";
    const firstPass = recs.filter(r => reachedPreview(r) && !r.repaired).length;

    const byKind: Record<string, { firstPass: number; total: number; rate: number }> = {};
    for (const r of recs) {
      const b = (byKind[r.diffKind] ??= { firstPass: 0, total: 0, rate: 0 });
      b.total++;
      if (reachedPreview(r) && !r.repaired) b.firstPass++;
    }
    for (const b of Object.values(byKind)) b.rate = b.total === 0 ? 0 : b.firstPass / b.total;

    const rejections: Record<string, number> = {};
    for (const r of recs) for (const rule of r.validatorRules) rejections[rule] = (rejections[rule] ?? 0) + 1;

    const failStages: Record<string, number> = {};
    for (const r of recs) if (r.failStage) failStages[r.failStage] = (failStages[r.failStage] ?? 0) + 1;

    return {
      attempts: n,
      firstPassCommitRate: rate(firstPass),
      firstPassByDiffKind: byKind,
      clarifyRate: rate(recs.filter(r => r.outcome === "clarify").length),
      failRate: rate(recs.filter(r => r.outcome === "failed").length),
      validatorRejections: Object.fromEntries(
        Object.entries(rejections).sort((a, b) => b[1] - a[1])),
      failStages,
      repairRate: rate(recs.filter(r => r.repaired).length),
    };
  }
}
