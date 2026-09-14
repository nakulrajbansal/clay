// Parsed compatibility API. Browser WorkerClient uses raw-client.ts instead;
// both paths share the identical bounded HTTP transport and repair capability.
import { MutationPlan } from "@clay/schema";
import { RawMutationClient, type RawPlanResult } from "./raw-client";
import type { S1Context } from "./prompt";
export { MUTATION_REQUEST_TIMEOUT_MS, MUTATION_RESPONSE_MAX_BYTES,
  type MutationClientOptions, type Transport } from "./raw-client";
type MutationPlanT = import("@clay/schema").MutationPlan;

/**
 * Trim display strings to the constitution's limits BEFORE Zod, so a merely
 * over-long summary/detail/assumption never fails validation and burns the
 * single repair round — which then leaves a REAL issue unrepairable and the
 * whole reshape failing (observed repeatedly in live traces). Truncation is
 * lossless in intent: these fields are human-facing prose, not data.
 */
function clip(s: unknown, max: number): unknown {
  return typeof s === "string" && s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
export function normalizeApiPlan(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const p = { ...(input as Record<string, unknown>) };
  if (typeof p.summary === "string") p.summary = clip(p.summary, 200);
  if (Array.isArray(p.assumptions))
    p.assumptions = p.assumptions.slice(0, 5).map(a => clip(a, 150));
  if (Array.isArray(p.user_facing_diff))
    p.user_facing_diff = p.user_facing_diff.map(d =>
      d && typeof d === "object"
        ? { ...(d as Record<string, unknown>), detail: clip((d as { detail?: unknown }).detail, 120) }
        : d);
  return p;
}

/**
 * The API grammar carries the variable-shape nested parts (migration, each
 * declared_queries entry) as JSON STRINGS to stay under the grammar cap
 * while every object stays closed (G1/ADR-013). Parse them back before Zod.
 * Tolerant of the already-object form so a hosted backend or a model that
 * emits objects directly still works.
 */
export function hydrateApiPlan(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const plan = { ...(input as Record<string, unknown>) };
  if (typeof plan.migration === "string") {
    const s = plan.migration.trim();
    plan.migration = s === "" || s === "null" ? null : JSON.parse(s);
  }
  if (Array.isArray(plan.panels)) {
    plan.panels = plan.panels.map(p => {
      if (!p || typeof p !== "object") return p;
      const panel = { ...(p as Record<string, unknown>) };
      if (Array.isArray(panel.declared_queries)) {
        panel.declared_queries = panel.declared_queries.map(
          q => (typeof q === "string" ? JSON.parse(q) : q));
      }
      // Boards and timelines lay out horizontally and clip in a half-width
      // panel; the API grammar can't carry a width, so widen them here to
      // FULL (4 cols, ADR-018) — the seed templates do the same. Reversible.
      if (typeof panel.code === "string"
        && /\b(Board|Timeline)\b/.test(panel.code)
        && panel.placement && typeof panel.placement === "object") {
        const pl = panel.placement as Record<string, unknown>;
        if (pl.w === undefined) panel.placement = { ...pl, w: 4 };
      }
      return panel;
    });
  }
  return plan;
}
export type PlanResult =
  | { ok: true; plan: MutationPlanT; raw: string;
      usage?: { input_tokens: number; output_tokens: number } }
  | { ok: false; error: { code: "E_NET" | "E_MODEL" | "E_PARSE" | "E_SCHEMA";
      message: string; issues?: string[]; raw?: string } };

/** Zod issues -> "path: message" strings the model can act on in repair. */
function formatIssues(issues: { path: (string | number)[]; message: string }[]): string[] {
  return issues.map(i => {
    const where = i.path.length ? i.path.join(".") : "(root)";
    return `${where}: ${i.message}`;
  });
}

export class MutationClient extends RawMutationClient {
  async requestPlan(ctx: S1Context): Promise<PlanResult> {
    return this.parse(await this.requestRawPlan(ctx));
  }
  async requestRepair(ctx: S1Context, priorPlanRaw: string, failures: string[]): Promise<PlanResult> {
    return this.parse(await this.requestRawRepair(ctx, priorPlanRaw, failures));
  }
  private parse(result: RawPlanResult): PlanResult {
    if (!result.ok) return result;
    const { raw, usage } = result;
    let json: unknown;
    try {
      json = normalizeApiPlan(hydrateApiPlan(JSON.parse(raw)));
    } catch (e) {
      return { ok: false, error: { code: "E_PARSE",
        message: `model output is not parseable: ${String(e)}`, raw } };
    }
    const parsed = MutationPlan.safeParse(json);   // full validation (G1)
    if (!parsed.success) {
      const issues = formatIssues(parsed.error.issues);
      return {
        ok: false,
        error: { code: "E_SCHEMA",
          message: `plan fails validation: ${issues.slice(0, 3).join("; ")}`,
          issues, raw },
      };
    }
    return usage !== undefined
      ? { ok: true, plan: parsed.data, raw, usage }
      : { ok: true, plan: parsed.data, raw };
  }
}
