// MutationPipeline: the S0–S6 stages (doc 05 §1), UI-agnostic.
//   S0 intake -> S1 context -> S2 plan (Planner) -> S3 static validation
//   -> S4 shadow dry-run -> S5 preview handle -> S6 keep | discard.
// Repair budget: ONE model round total per attempt, whether triggered at
// S3 or S4. Second failure -> visible failure (amber card in the shell).
// The Planner is a structural interface so the kernel never depends on
// @clay/mutation; the shell passes a MutationClient.
import { MutationPlan as MutationPlanSchema } from "@clay/schema";
import type { z } from "zod";
import { ClayError } from "./errors";
import { deriveInverse } from "./migrate";
import type { ClayStore, PanelBlobInput } from "./store";
import { missingDiffLines, validateMutationPlan, type ValidationIssue } from "./validate";

type MutationPlanT = z.infer<typeof MutationPlanSchema>;
type QueryT = import("@clay/schema").Query;

export type PlannerContext = {
  registry: unknown[];
  panels: {
    id: string; title: string;
    placement: { region: string; order: number };
    declared_queries: unknown[]; declared_writes: string[];
    description: string; code?: string;
  }[];
  recentSummaries: string[];
  intent: string;
};

export type PlannerResult =
  | { ok: true; plan: unknown; raw: string }
  | { ok: false; error: {
      code: string; message: string;
      /** formatted reasons (e.g. Zod issues) for the repair prompt + card */
      issues?: string[];
      /** the model's raw output, so a schema/parse failure can be repaired */
      raw?: string;
    } };

export type Planner = {
  requestPlan(ctx: PlannerContext): Promise<PlannerResult>;
  requestRepair(ctx: PlannerContext, priorPlanRaw: string, failures: string[]): Promise<PlannerResult>;
};

/** Structured trace of one attempt through the pipeline (for logs/review). */
export type DebugEvent =
  | { stage: "intake"; intent: string; registryTables: string[]; panelCount: number }
  | { stage: "plan"; raw: string | null; ok: boolean; error?: string }
  | { stage: "repair"; trigger: "schema" | "validate" | "dry_run"; reasons: string[] }
  | { stage: "validate"; issues: string[] }
  | { stage: "dry_run"; ok: boolean; error?: string }
  | { stage: "outcome"; status: string; repaired: boolean };

/** S4 smoke hook. Default: run every concrete declared query against the
 * shadow. The browser shell replaces this with a real panel boot +
 * 2s render watch; both throw to signal a dry-run failure. */
export type SmokeTest = (shadow: ClayStore, plan: MutationPlanT) => Promise<void>;

export type PreviewHandle = {
  plan: MutationPlanT;
  /** the migrated shadow store — the PreviewHost renders panels against it */
  shadow: ClayStore;
  version: number;               // the version keep() will create
  keep(): number;                // S6 commit on the LIVE store (doc 05 §6, G8)
  discard(): void;
};

export type AttemptResult =
  | { status: "clarify"; question: string; attemptId: string }
  | { status: "preview"; preview: PreviewHandle; attemptId: string; repaired: boolean }
  | { status: "failed"; stage: "plan" | "validate" | "dry_run";
      reasons: string[]; attemptId: string };

const hasVar = (q: unknown): boolean => JSON.stringify(q).includes('"$var"');

export const defaultSmokeTest: SmokeTest = async (shadow, plan) => {
  for (const p of plan.panels) {
    for (const q of p.declared_queries) {
      if (hasVar(q)) continue;
      shadow.query(q as QueryT);   // throws ClayError on schema mismatch
    }
  }
};

const issueStrings = (issues: ValidationIssue[]): string[] =>
  issues.map(i => `${i.rule}${i.panel ? ` [${i.panel}]` : ""}: ${i.message}`);

function toCommitPanels(plan: MutationPlanT): PanelBlobInput[] {
  return plan.panels.map(p => ({
    panel_id: p.panel_id, title: p.title,
    placement: p.placement, code: p.code,
    declared_queries: p.declared_queries,
    declared_writes: p.declared_writes,
  }));
}

export class MutationPipeline {
  private readonly smokeTest: SmokeTest;
  private readonly onDebug?: (ev: DebugEvent) => void;

  constructor(
    private readonly store: ClayStore,
    private readonly planner: Planner,
    opts: { smokeTest?: SmokeTest; onDebug?: (ev: DebugEvent) => void } = {},
  ) {
    this.smokeTest = opts.smokeTest ?? defaultSmokeTest;
    this.onDebug = opts.onDebug;
  }

  /** S1: registry + panel manifest + last 5 summaries + intent. NEVER rows.
   * A panel's full CODE is included when the intent likely targets it — by
   * its id, title, or (crucially) any TABLE it reads: "add a priority to
   * the jobs table" must ship jobs-panel code so the model can return a
   * correct whole-file replacement instead of regenerating from scratch. */
  buildContext(intent: string): PlannerContext {
    const words = new Set(intent.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean));
    const mentions = (s: string): boolean => {
      const t = s.toLowerCase();
      return words.has(t) || words.has(t.replace(/s$/, "")) || words.has(`${t}s`);
    };
    const registry = [...this.store.registrySnapshot().values()];
    return {
      registry,
      panels: this.store.livePanels().map(p => {
        const tables = [...new Set(p.declared_queries.map(q => q.from))];
        const targeted =
          mentions(p.panel_id) || mentions(p.title)
          || p.panel_id.split("_").some(mentions)
          || p.title.split(/\s+/).some(mentions)
          || tables.some(mentions);
        return {
          id: p.panel_id, title: p.title, placement: p.placement,
          declared_queries: p.declared_queries, declared_writes: p.declared_writes,
          description: `${p.title} (${p.placement.region}) over ${tables.join(", ") || "no tables"}`,
          ...(targeted ? { code: p.code } : {}),
        };
      }),
      recentSummaries: this.store.recentSummaries(5),
      intent,
    };
  }

  async run(intent: string): Promise<AttemptResult> {
    const attemptId = this.store.beginAttempt(intent);          // S0
    const ctx = this.buildContext(intent);                      // S1
    let repairUsed = false;
    const debug = (ev: DebugEvent): void => this.onDebug?.(ev);
    debug({ stage: "intake", intent,
      registryTables: ctx.registry.map(t => (t as { name: string }).name),
      panelCount: ctx.panels.length });

    const fail = (stage: "plan" | "validate" | "dry_run", reasons: string[],
      code: string): AttemptResult => {
      this.store.finishAttempt(attemptId, "failed", code);
      debug({ stage: "outcome", status: `failed@${stage}`, repaired: repairUsed });
      return { status: "failed", stage, reasons, attemptId };
    };

    // S2
    let result = await this.planner.requestPlan(ctx);
    debug({ stage: "plan", ok: result.ok,
      raw: result.ok ? result.raw : (result.error.raw ?? null),
      error: result.ok ? undefined : result.error.message });

    for (;;) {
      // Client-side failure (bad JSON or fails the Zod constitution). This
      // IS an S3-class failure — repairable once, with the issues fed back.
      if (!result.ok) {
        const { code, message, issues, raw } = result.error;
        const recoverable = (code === "E_SCHEMA" || code === "E_PARSE") && !!raw;
        const reasons = issues && issues.length > 0 ? issues : [message];
        if (recoverable && !repairUsed) {
          repairUsed = true;
          debug({ stage: "repair", trigger: "schema", reasons });
          result = await this.planner.requestRepair(ctx, raw!, reasons);
          debug({ stage: "plan", ok: result.ok,
            raw: result.ok ? result.raw : (result.error.raw ?? null),
            error: result.ok ? undefined : result.error.message });
          continue;
        }
        return fail("plan", reasons, code);
      }

      // Reversibility is kernel-owned: replace the model's hand-written
      // inverse with the canonical derivation (exactly what the I2 check
      // demands). Models routinely order inverse ops "undo-style" (reversed),
      // which used to fail V5 and then cascade into bogus V4 unknown-table
      // issues because panel checks fell back to the pre-migration registry.
      // If the forward ops themselves are invalid, deriveInverse throws and
      // we leave the plan untouched so V5 reports the real problem.
      {
        const p = result.plan as { migration?: MutationPlanT["migration"] } | null;
        if (p && typeof p === "object" && p.migration
            && Array.isArray(p.migration.operations)) {
          try {
            p.migration.inverse =
              deriveInverse(p.migration.operations, this.store.registrySnapshot());
          } catch { /* invalid op sequence — V5 below states it */ }
        }
        // Same spirit for V7 (ADR-021): a plan that changes things but
        // forgot a matching diff LINE is a bookkeeping miss, not a bad plan.
        // Append the missing lines (schema caps the array at 12; if there's
        // no room, leave it and let V7 say so).
        const plan = result.plan as MutationPlanT | null;
        if (plan && typeof plan === "object" && Array.isArray(plan.user_facing_diff)) {
          try {
            const missing = missingDiffLines(plan,
              new Set(this.store.livePanels().map(lp => lp.panel_id)));
            if (missing.length > 0
                && plan.user_facing_diff.length + missing.length <= 12)
              plan.user_facing_diff.push(...missing);
          } catch { /* malformed plan — validator reports it */ }
        }
      }

      // S3: the Validator (V1–V7)
      const issues = validateMutationPlan(result.plan, {
        registry: this.store.registrySnapshot(),
        livePanelIds: this.store.livePanels().map(p => p.panel_id),
      });
      if (issues.length > 0) {
        debug({ stage: "validate", issues: issueStrings(issues) });
        if (repairUsed) return fail("validate", issueStrings(issues), "E_VALIDATION");
        repairUsed = true;
        // Focus the single repair round on the root cause: when the
        // migration itself failed, panel checks ran against the stale
        // registry, so their "unknown table/column" issues are downstream
        // noise that only distracts the repair model.
        const migrationIssues = issues.filter(i => i.panel === undefined);
        const repairIssues = migrationIssues.length > 0 ? migrationIssues : issues;
        debug({ stage: "repair", trigger: "validate", reasons: issueStrings(repairIssues) });
        result = await this.planner.requestRepair(ctx, result.raw, issueStrings(repairIssues));
        debug({ stage: "plan", ok: result.ok,
          raw: result.ok ? result.raw : (result.error.raw ?? null),
          error: result.ok ? undefined : result.error.message });
        continue;
      }

      const plan = MutationPlanSchema.parse(result.plan);
      if (plan.clarifying_question) {
        this.store.finishAttempt(attemptId, "clarify");
        debug({ stage: "outcome", status: "clarify", repaired: repairUsed });
        return { status: "clarify", question: plan.clarifying_question, attemptId };
      }

      // S4: shadow dry-run — backup, migrate shadow, smoke
      const shadow = await this.store.shadowCopy();
      try {
        shadow.commit({
          intent, summary: plan.summary, migration: plan.migration,
          panels: toCommitPanels(plan), removePanels: plan.remove_panels,
          diff: plan.user_facing_diff,
        });
        await this.smokeTest(shadow, plan);
        debug({ stage: "dry_run", ok: true });
      } catch (e) {
        shadow.close();
        const reason = e instanceof ClayError ? `${e.code}: ${e.message}` : String(e);
        debug({ stage: "dry_run", ok: false, error: reason });
        if (repairUsed) return fail("dry_run", [reason], "E_DRY_RUN");
        repairUsed = true;
        debug({ stage: "repair", trigger: "dry_run", reasons: [reason] });
        result = await this.planner.requestRepair(ctx, result.raw, [reason]);
        debug({ stage: "plan", ok: result.ok,
          raw: result.ok ? result.raw : (result.error.raw ?? null),
          error: result.ok ? undefined : result.error.message });
        continue;
      }

      // S5: preview in place; S6 on the caller's Keep/Discard
      const store = this.store;
      const preview: PreviewHandle = {
        plan, shadow, version: store.headVersion() + 1,
        keep: (): number => {
          // migrations are shape-level: applying to the LIVE db is safe even
          // if rows were added while previewing (G8)
          const version = store.commit({
            intent, summary: plan.summary, migration: plan.migration,
            panels: toCommitPanels(plan), removePanels: plan.remove_panels,
            diff: plan.user_facing_diff,
          });
          store.finishAttempt(attemptId, "kept");
          shadow.close();
          return version;
        },
        discard: (): void => {
          store.finishAttempt(attemptId, "discarded");
          shadow.close();   // shadow.db deleted after every run (doc 04 §8)
        },
      };
      debug({ stage: "outcome", status: "preview", repaired: repairUsed });
      return { status: "preview", preview, attemptId, repaired: repairUsed };
    }
  }
}
