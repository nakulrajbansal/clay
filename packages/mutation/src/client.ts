// MutationClient (doc 02 §5): S2 plan generation over the hosted proxy or
// BYO direct-browser mode (doc 07 §6, G3). Structured output uses the
// SIMPLIFIED API schema (G1/ADR-013) — the grammar guarantees parseability;
// the full Zod constitution validates client-side either way.
//
// BYO mode deliberately uses raw fetch instead of @anthropic-ai/sdk: the
// client dependency budget is ADR-gated (CLAUDE.md rule 4, doc 06 §6) and
// the surface is one POST. Re-evaluate if the surface grows.
import { MutationPlan } from "@clay/schema";
import apiSchemaRaw from "@clay/schema/mutation-plan-api.json";

// The API's structured-output grammar rejects annotation keywords like
// $comment. Keep them in the source file (self-documenting) but strip them
// from the schema we actually send. Deterministic, so the sent bytes stay
// stable for grammar caching (G1/ADR-013).
function stripAnnotations(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripAnnotations);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$comment") continue;
      out[k] = stripAnnotations(v);
    }
    return out;
  }
  return node;
}
const apiSchema = stripAnnotations(apiSchemaRaw);

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
      return panel;
    });
  }
  return plan;
}
import {
  ANTHROPIC_API_URL, ANTHROPIC_VERSION, DEFAULT_MODEL, MAX_TOKENS,
  REPAIR_MODEL, TEMPERATURE,
} from "./config/models";
import {
  MutationRequestError, buildRepairTurn, buildSystemPrompt, buildUserTurn,
  type S1Context,
} from "./prompt";

type MutationPlanT = import("@clay/schema").MutationPlan;

export type Transport =
  | { mode: "byo"; apiKey: string }
  | { mode: "hosted"; endpoint: string };

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

type FetchLike = (url: string, init: {
  method: string; headers: Record<string, string>; body: string;
}) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export type MutationClientOptions = {
  fetchFn?: FetchLike;
  /** G2: escalate repair rounds to the Opus-class model. */
  modelRepair?: boolean;
};

type AnthropicResponse = {
  content?: { type: string; text?: string }[];
  usage?: { input_tokens: number; output_tokens: number };
  stop_reason?: string;
};

export class MutationClient {
  private readonly fetchFn: FetchLike;
  private readonly modelRepair: boolean;
  readonly systemPrompt: string;

  constructor(private readonly transport: Transport, opts: MutationClientOptions = {}) {
    // fetch must stay bound to the global scope — storing it unbound and
    // calling this.fetchFn(...) throws "Illegal invocation" in browsers.
    this.fetchFn = opts.fetchFn
      ?? ((url, init): ReturnType<FetchLike> =>
        (fetch as unknown as FetchLike)(url, init));
    this.modelRepair = opts.modelRepair ?? false;
    this.systemPrompt = buildSystemPrompt();
  }

  requestPlan(ctx: S1Context): Promise<PlanResult> {
    return this.run(ctx, null);
  }

  /** One repair round total per attempt (doc 05 §1). */
  requestRepair(ctx: S1Context, priorPlanRaw: string, failures: string[]): Promise<PlanResult> {
    return this.run(ctx, { priorPlanRaw, failures });
  }

  /**
   * Raw model output for the hosted backend to relay (the client re-runs
   * hydrate + Zod + the repair loop, so a schema/parse failure must still
   * flow back as raw). Throws MutationRequestError on a hard model/network
   * failure so the proxy can map it to a 5xx.
   */
  async rawPlan(ctx: S1Context): Promise<string> {
    return this.rawFor(await this.requestPlan(ctx));
  }
  async rawRepair(ctx: S1Context, priorPlanRaw: string, failures: string[]): Promise<string> {
    return this.rawFor(await this.requestRepair(ctx, priorPlanRaw, failures));
  }
  private rawFor(r: PlanResult): string {
    if (r.ok) return r.raw;
    if (r.error.raw !== undefined) return r.error.raw;   // schema/parse: relay
    throw new MutationRequestError(r.error.code, r.error.message);
  }

  private async run(
    ctx: S1Context,
    repair: { priorPlanRaw: string; failures: string[] } | null,
  ): Promise<PlanResult> {
    let raw: string;
    let usage: { input_tokens: number; output_tokens: number } | undefined;
    try {
      if (this.transport.mode === "byo") {
        const r = await this.byoRequest(ctx, repair);
        raw = r.raw; usage = r.usage;
      } else {
        raw = await this.hostedRequest(this.transport.endpoint, ctx, repair);
      }
    } catch (e) {
      if (e instanceof MutationRequestError && e.code !== "E_NET")
        return { ok: false, error: { code: "E_MODEL", message: e.message } };
      return { ok: false, error: { code: "E_NET", message: String(e) } };
    }

    let json: unknown;
    try {
      json = hydrateApiPlan(JSON.parse(raw));
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

  private buildMessages(
    ctx: S1Context,
    repair: { priorPlanRaw: string; failures: string[] } | null,
  ): { role: string; content: string }[] {
    const messages: { role: string; content: string }[] = [
      { role: "user", content: buildUserTurn(ctx) },
    ];
    if (repair) {
      messages.push({ role: "assistant", content: repair.priorPlanRaw });
      messages.push({ role: "user", content: buildRepairTurn(repair.failures, repair.priorPlanRaw) });
    }
    return messages;
  }

  private async byoRequest(
    ctx: S1Context,
    repair: { priorPlanRaw: string; failures: string[] } | null,
  ): Promise<{ raw: string; usage?: { input_tokens: number; output_tokens: number } }> {
    if (this.transport.mode !== "byo") throw new MutationRequestError("E_NET", "not byo");
    const body = {
      model: repair && this.modelRepair ? REPAIR_MODEL : DEFAULT_MODEL,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      system: this.systemPrompt,
      messages: this.buildMessages(ctx, repair),
      // Keep this schema byte-stable for grammar caching (G1/ADR-013).
      output_config: { format: { type: "json_schema", schema: apiSchema } },
    };
    const res = await this.fetchFn(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.transport.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        // Confirmed header name (G3): BYO keys are sent ONLY to Anthropic (P3).
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok)
      // include the response body: the API's own message is the diagnosis
      throw new MutationRequestError("E_MODEL",
        `anthropic ${res.status}: ${text.slice(0, 400)}`);
    const parsed = JSON.parse(text) as AnthropicResponse;
    const block = parsed.content?.find(c => c.type === "text");
    if (!block?.text)
      throw new MutationRequestError("E_MODEL", "no text block in response");
    return { raw: block.text, usage: parsed.usage };
  }

  private async hostedRequest(
    endpoint: string,
    ctx: S1Context,
    repair: { priorPlanRaw: string; failures: string[] } | null,
  ): Promise<string> {
    // Doc 07 §1: the backend assembles the prompt; the wire carries schema
    // shapes + intent only (B2). Repairs count against the same attempt.
    const path = repair ? "/mutations/repair" : "/mutations/plan";
    const res = await this.fetchFn(`${endpoint}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(repair
        ? { context: ctx, prior_plan: repair.priorPlanRaw, failures: repair.failures }
        : { context: ctx }),
    });
    const text = await res.text();
    if (!res.ok)
      throw new MutationRequestError("E_MODEL",
        `backend ${res.status}: ${text.slice(0, 400)}`);
    return text;
  }
}
