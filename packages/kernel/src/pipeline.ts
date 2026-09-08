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
import { deriveInverse, validateMigrationPlan } from "./migrate";
import { expandBlueprint, parseBlueprintDirective } from "./blueprints";
import type {
  PlannerMutationAuthority,
  PlanningCapture,
  PreparedMutationPreview,
  PreviewShadow,
} from "./planner-authority";
import { capturePlannerPlanData } from "./planner-command";
export { createInProcessPlannerMutationAuthority } from "./planner-authority";
export type {
  PlannerMutationAuthority,
  PreparedMutationPreview,
  PreviewShadow,
} from "./planner-authority";
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

function clipPlannerDisplay(value: unknown, max: number): unknown {
  return typeof value === "string" && value.length > max
    ? `${value.slice(0, max - 1)}…` : value;
}

function hydratePlannerWire(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const plan = { ...(input as Record<string, unknown>) };
  if (typeof plan.migration === "string") {
    const value = plan.migration.trim();
    plan.migration = value === "" || value === "null" ? null : JSON.parse(value);
  }
  if (Array.isArray(plan.panels)) {
    plan.panels = plan.panels.map(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const panel = { ...(value as Record<string, unknown>) };
      if (Array.isArray(panel.declared_queries)) {
        panel.declared_queries = panel.declared_queries.map(query =>
          typeof query === "string" ? JSON.parse(query) : query);
      }
      if (typeof panel.code === "string"
          && /\b(Board|Timeline)\b/.test(panel.code)
          && panel.placement && typeof panel.placement === "object"
          && !Array.isArray(panel.placement)) {
        const placement = panel.placement as Record<string, unknown>;
        if (placement.w === undefined) panel.placement = { ...placement, w: 4 };
      }
      return panel;
    });
  }
  plan.summary = clipPlannerDisplay(plan.summary, 200);
  if (Array.isArray(plan.assumptions)) {
    plan.assumptions = plan.assumptions.slice(0, 5)
      .map(assumption => clipPlannerDisplay(assumption, 150));
  }
  if (Array.isArray(plan.user_facing_diff)) {
    plan.user_facing_diff = plan.user_facing_diff.map(value =>
      value && typeof value === "object" && !Array.isArray(value)
        ? { ...(value as Record<string, unknown>),
          detail: clipPlannerDisplay((value as { detail?: unknown }).detail, 120) }
        : value);
  }
  return plan;
}

/** Decode opaque model bytes inside the trusted pipeline closure. */
export function decodePlannerRaw(raw: string): PlannerResult {
  let hydrated: unknown;
  try {
    hydrated = hydratePlannerWire(JSON.parse(raw));
  } catch (error) {
    return { ok: false, error: {
      code: "E_PARSE", message: `model output is not parseable: ${String(error)}`, raw,
    } };
  }
  const parsed = MutationPlanSchema.safeParse(hydrated);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue =>
      `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`);
    return { ok: false, error: {
      code: "E_SCHEMA",
      message: `plan fails validation: ${issues.slice(0, 3).join("; ")}`,
      issues, raw,
    } };
  }
  return { ok: true, plan: parsed.data, raw };
}

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
export type SmokeTest = (shadow: PreviewShadow, plan: MutationPlanT) => Promise<void>;

export type AttemptResult =
  | { status: "clarify"; question: string; attemptId: string; repaired: boolean }
  | { status: "preview"; preview: PreparedMutationPreview; attemptId: string; repaired: boolean }
  | { status: "failed"; stage: "plan" | "validate" | "dry_run";
      reasons: string[]; attemptId: string; repaired: boolean };

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

export class MutationPipeline {
  private readonly smokeTest: SmokeTest;
  private readonly onDebug?: (ev: DebugEvent) => void;

  constructor(
    private readonly authority: PlannerMutationAuthority,
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
    return this.buildContextFromCapture(intent, this.authority.capturePlanningBase());
  }

  private buildContextFromCapture(intent: string, capture: PlanningCapture): PlannerContext {
    const words = new Set(intent.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean));
    const mentions = (s: string): boolean => {
      const t = s.toLowerCase();
      return words.has(t) || words.has(t.replace(/s$/, "")) || words.has(`${t}s`);
    };
    return {
      registry: [...capture.registry.values()],
      panels: capture.livePanels.map(p => {
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
      recentSummaries: [...capture.recentSummaries],
      intent,
    };
  }

  async run(intent: string): Promise<AttemptResult> {
    const attemptId = await this.authority.beginAttempt(intent); // S0
    const capture = this.authority.capturePlanningBase();        // S1
    const ctx = this.buildContextFromCapture(intent, capture);
    let repairUsed = false;
    const debug = (ev: DebugEvent): void => this.onDebug?.(ev);
    debug({ stage: "intake", intent,
      registryTables: ctx.registry.map(t => (t as { name: string }).name),
      panelCount: ctx.panels.length });

    const fail = async (stage: "plan" | "validate" | "dry_run", reasons: string[],
      code: string): Promise<AttemptResult> => {
      await this.authority.finalizeAttempt(attemptId, "failed", code);
      debug({ stage: "outcome", status: `failed@${stage}`, repaired: repairUsed });
      return { status: "failed", stage, reasons, attemptId, repaired: repairUsed };
    };
    const callPlanner = async (operation: () => Promise<PlannerResult>): Promise<PlannerResult> => {
      try { return await operation(); }
      catch (error) {
        await this.authority.finalizeAttempt(attemptId, "failed",
          error instanceof ClayError ? error.code : "E_MODEL");
        debug({ stage: "outcome", status: "failed@plan", repaired: repairUsed });
        throw error;
      }
    };

    // S2
    let result = await callPlanner(() => this.planner.requestPlan(ctx));
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
          result = await callPlanner(() => this.planner.requestRepair(ctx, raw!, reasons));
          debug({ stage: "plan", ok: result.ok,
            raw: result.ok ? result.raw : (result.error.raw ?? null),
            error: result.ok ? undefined : result.error.message });
          continue;
        }
        return await fail("plan", reasons, code);
      }

      const priorRaw = result.raw;

      try {
        result = { ...result, plan: capturePlannerPlanData(result.plan) };
      } catch (error) {
        const reason = error instanceof ClayError
          ? `${error.code}: ${error.message}` : String(error);
        if (repairUsed)
          return await fail("validate", [reason],
            error instanceof ClayError ? error.code : "E_VALIDATION");
        repairUsed = true;
        debug({ stage: "repair", trigger: "validate", reasons: [reason] });
        result = await callPlanner(() => this.planner.requestRepair(ctx, priorRaw, [reason]));
        debug({ stage: "plan", ok: result.ok,
          raw: result.ok ? result.raw : (result.error.raw ?? null),
          error: result.ok ? undefined : result.error.message });
        continue;
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
              deriveInverse(p.migration.operations, capture.registry);
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
              new Set(capture.livePanels.map(lp => lp.panel_id)));
            if (missing.length > 0
                && plan.user_facing_diff.length + missing.length <= 12)
              plan.user_facing_diff.push(...missing);
          } catch { /* malformed plan — validator reports it */ }
        }
      }

      // Blueprints (ADR-029): expand `//#blueprint {...}` directives into
      // canonical code with DERIVED declared_queries/writes, against the
      // POST-migration registry (a blueprint may target a table this same
      // plan creates). Expansion failures become precise validation issues
      // for the single repair round; the output goes through the same
      // Validator as hand-written code — nothing is widened.
      const blueprintIssues: ValidationIssue[] = [];
      {
        const plan = result.plan as MutationPlanT | null;
        if (plan && typeof plan === "object" && Array.isArray(plan.panels)) {
          let reg = capture.registry;
          if (plan.migration) {
            try { reg = validateMigrationPlan(plan.migration, reg); }
            catch { /* bad migration — V5 reports; expand pre-migration */ }
          }
          for (const p of plan.panels) {
            if (!p || typeof p.code !== "string") continue;
            let spec: unknown;
            try { spec = parseBlueprintDirective(p.code); }
            catch {
              blueprintIssues.push({ rule: "V1", panel: p.panel_id,
                message: "blueprint: the directive is not valid JSON" });
              continue;
            }
            if (spec === null) continue;
            try {
              const ex = expandBlueprint(spec, reg);
              p.code = ex.code;
              p.declared_queries = ex.declared_queries as typeof p.declared_queries;
              p.declared_writes = ex.declared_writes;
            } catch (e) {
              blueprintIssues.push({ rule: "V1", panel: p.panel_id,
                message: e instanceof Error ? e.message : String(e) });
            }
          }
        }
      }

      // S3: the Validator (V1–V7)
      const issues = [...blueprintIssues, ...validateMutationPlan(result.plan, {
        registry: capture.validationRegistry,
        livePanelIds: capture.livePanels.map(p => p.panel_id),
      })];
      if (issues.length > 0) {
        debug({ stage: "validate", issues: issueStrings(issues) });
        if (repairUsed) return await fail("validate", issueStrings(issues), "E_VALIDATION");
        repairUsed = true;
        // Focus the single repair round on the root cause: when the
        // migration itself failed, panel checks ran against the stale
        // registry, so their "unknown table/column" issues are downstream
        // noise that only distracts the repair model.
        const migrationIssues = issues.filter(i => i.panel === undefined);
        const repairIssues = migrationIssues.length > 0 ? migrationIssues : issues;
        debug({ stage: "repair", trigger: "validate", reasons: issueStrings(repairIssues) });
        result = await callPlanner(() =>
          this.planner.requestRepair(ctx, priorRaw, issueStrings(repairIssues)));
        debug({ stage: "plan", ok: result.ok,
          raw: result.ok ? result.raw : (result.error.raw ?? null),
          error: result.ok ? undefined : result.error.message });
        continue;
      }

      const plan = MutationPlanSchema.parse(result.plan);
      if (plan.clarifying_question) {
        await this.authority.finalizeAttempt(attemptId, "clarify");
        debug({ stage: "outcome", status: "clarify", repaired: repairUsed });
        return {
          status: "clarify", question: plan.clarifying_question,
          attemptId, repaired: repairUsed,
        };
      }

      // S4: create one immutable exact-base command while preparing a
      // disposable shadow. S6 receives data only; no live Store capability.
      let preview: PreparedMutationPreview | null = null;
      try {
        preview = await this.authority.preparePreview({
          attemptId,
          base: capture.base,
          intent,
          plan,
        });
        await this.smokeTest(preview.shadow, preview.plan);
        try {
          this.authority.assertPlanningBase(capture.base);
        } catch {
          preview.shadow.close();
          return await fail("dry_run", [
            "App changed during validation. Reshape again from the latest version.",
          ], "E_CONFLICT");
        }
        debug({ stage: "dry_run", ok: true });
      } catch (e) {
        preview?.shadow.close();
        const reason = e instanceof ClayError ? `${e.code}: ${e.message}` : String(e);
        debug({ stage: "dry_run", ok: false, error: reason });
        if (e instanceof ClayError && e.code === "E_CONFLICT")
          return await fail("dry_run", [reason], "E_CONFLICT");
        if (repairUsed) return await fail("dry_run", [reason], "E_DRY_RUN");
        repairUsed = true;
        debug({ stage: "repair", trigger: "dry_run", reasons: [reason] });
        result = await callPlanner(() => this.planner.requestRepair(ctx, priorRaw, [reason]));
        debug({ stage: "plan", ok: result.ok,
          raw: result.ok ? result.raw : (result.error.raw ?? null),
          error: result.ok ? undefined : result.error.message });
        continue;
      }

      // S5 returns immutable data plus a shadow-only resource. S6 decisions
      // are explicit authority calls and shadow closure is separate.
      if (!preview) throw new ClayError("E_INTERNAL", "preview preparation returned no state");
      debug({ stage: "outcome", status: "preview", repaired: repairUsed });
      return { status: "preview", preview, attemptId, repaired: repairUsed };
    }
  }
}
