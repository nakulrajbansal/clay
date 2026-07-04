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
      message: string; issues?: unknown } };

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
        return { ok: false, error: { code: "E_MODEL", message: e.message, issues: e.detail } };
      return { ok: false, error: { code: "E_NET", message: String(e) } };
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { ok: false, error: { code: "E_PARSE", message: "model output is not JSON" } };
    }
    const parsed = MutationPlan.safeParse(json);   // full validation (G1)
    if (!parsed.success) {
      return {
        ok: false,
        error: { code: "E_SCHEMA", message: "plan fails the Zod constitution",
          issues: parsed.error.issues },
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
