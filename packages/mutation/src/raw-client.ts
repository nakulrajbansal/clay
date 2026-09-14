// Trusted-shell raw planner transport. Provider HTTP and credentials stay here.
// Opaque model bytes are NOT a plan: db-worker's decodePlannerRaw performs the
// closed schema validation before Preview/Keep. The parsed compatibility API
// remains in client.ts for non-worker consumers.
//
// BYO mode deliberately uses raw fetch instead of @anthropic-ai/sdk: the
// client dependency budget is ADR-gated (CLAUDE.md rule 4, doc 06 §6) and
// the surface is one POST. Re-evaluate if the surface grows.
import { WIRE_SCHEMA as apiSchema } from "./wire-schema.gen";

function strictifyObjects(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictifyObjects);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) out[key] = strictifyObjects(value);
    if (out.properties && typeof out.properties === "object") {
      out.required = Object.keys(out.properties as Record<string, unknown>);
      out.additionalProperties = false;
    }
    return out;
  }
  return node;
}
const openaiApiSchema = strictifyObjects(apiSchema);

import {
  ANTHROPIC_API_URL, ANTHROPIC_VERSION, DEFAULT_MODEL, DEFAULT_OPENAI_MODEL,
  MAX_TOKENS, OPENAI_API_URL,
  REPAIR_MODEL, TEMPERATURE,
} from "./config/models";
import {
  MutationRequestError, buildRepairTurn, buildSystemPrompt, buildUserTurn,
  type S1Context,
} from "./prompt";
import { BoundedResponseTextError, readBoundedResponseText } from "./bounded-response";

export type Transport =
  | { mode: "byo"; apiKey: string }
  | { mode: "openai"; apiKey: string; model?: string; endpoint?: string }
  | { mode: "hosted"; endpoint: string; session?: string; credentials?: "include" };

export type RawPlanResult =
  | { ok: true; raw: string; usage?: { input_tokens: number; output_tokens: number } }
  | { ok: false; error: { code: "E_NET" | "E_MODEL"; message: string } };

type FetchLike = (url: string, init: {
  method: string; headers: Record<string, string>; body: string; signal?: AbortSignal;
}) => Promise<Pick<Response, "ok" | "status" | "body" | "headers">>;

export type MutationClientOptions = {
  fetchFn?: FetchLike;
  /** G2: escalate repair rounds to the Opus-class model. */
  modelRepair?: boolean;
  /** Per-intent shell lifecycle cancellation. */
  signal?: AbortSignal;
  /** Hard wall-clock deadline for fetch plus streamed response consumption. */
  requestTimeoutMs?: number;
};

export const MUTATION_REQUEST_TIMEOUT_MS = 180_000;
export const MUTATION_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const MUTATION_ERROR_RESPONSE_MAX_BYTES = 64 * 1024;

type AnthropicResponse = {
  content?: { type: string; text?: string }[];
  usage?: { input_tokens: number; output_tokens: number };
  stop_reason?: string;
};

type OpenAIResponse = {
  status?: string;
  output?: Array<{ type?: string; content?: Array<{
    type?: string; text?: string; refusal?: string;
  }> }>;
  usage?: { input_tokens: number; output_tokens: number };
};

export class RawMutationClient {
  private readonly fetchFn: FetchLike;
  private readonly modelRepair: boolean;
  private readonly signal?: AbortSignal;
  private readonly requestTimeoutMs: number;
  private hostedRepairCapability: Readonly<{
    endpoint: string; contextJson: string; priorPlanRaw: string; token: string;
  }> | null = null;
  readonly systemPrompt: string;

  constructor(private readonly transport: Transport, opts: MutationClientOptions = {}) {
    // fetch must stay bound to the global scope — storing it unbound and
    // calling this.fetchFn(...) throws "Illegal invocation" in browsers.
    this.fetchFn = opts.fetchFn
      ?? ((url, init): ReturnType<FetchLike> =>
        (fetch as unknown as FetchLike)(url, init));
    this.modelRepair = opts.modelRepair ?? false;
    this.signal = opts.signal;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? MUTATION_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.requestTimeoutMs)
        || this.requestTimeoutMs < 1 || this.requestTimeoutMs > MUTATION_REQUEST_TIMEOUT_MS)
      throw new TypeError("model request timeout is invalid");
    this.systemPrompt = buildSystemPrompt();
  }

  requestRawPlan(ctx: S1Context): Promise<RawPlanResult> {
    return this.run(ctx, null);
  }

  /** One repair round total per attempt (doc 05 §1). */
  requestRawRepair(ctx: S1Context, priorPlanRaw: string, failures: string[]): Promise<RawPlanResult> {
    return this.run(ctx, { priorPlanRaw, failures });
  }

  /**
   * Exact untrusted output for the worker pipeline or hosted relay. Even bad
   * JSON must reach the single authority-owned repair loop unchanged. Hard
   * model/network failures retain their existing typed error contract.
   */
  async rawPlan(ctx: S1Context): Promise<string> {
    return this.rawFor(await this.requestRawPlan(ctx));
  }
  async rawRepair(ctx: S1Context, priorPlanRaw: string, failures: string[]): Promise<string> {
    return this.rawFor(await this.requestRawRepair(ctx, priorPlanRaw, failures));
  }
  private rawFor(r: RawPlanResult): string {
    if (r.ok) return r.raw;
    throw new MutationRequestError(r.error.code, r.error.message);
  }

  private async run(
    ctx: S1Context,
    repair: { priorPlanRaw: string; failures: string[] } | null,
  ): Promise<RawPlanResult> {
    let raw: string;
    let usage: { input_tokens: number; output_tokens: number } | undefined;
    try {
      if (this.transport.mode === "byo") {
        const r = await this.byoRequest(ctx, repair);
        raw = r.raw; usage = r.usage;
      } else if (this.transport.mode === "openai") {
        const r = await this.openaiRequest(ctx, repair);
        raw = r.raw; usage = r.usage;
      } else {
        raw = await this.hostedRequest(this.transport.endpoint, ctx, repair);
      }
    } catch (e) {
      if (e instanceof MutationRequestError && e.code !== "E_NET")
        return { ok: false, error: { code: "E_MODEL", message: e.message } };
      return { ok: false, error: { code: "E_NET", message: String(e) } };
    }

    return usage !== undefined ? { ok: true, raw, usage } : { ok: true, raw };
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

  private async readResponseText(
    response: Pick<Response, "ok" | "status" | "body" | "headers">,
  ): Promise<string> {
    try {
      return await readBoundedResponseText(
        response,
        response.ok ? MUTATION_RESPONSE_MAX_BYTES : MUTATION_ERROR_RESPONSE_MAX_BYTES,
      );
    } catch (error) {
      if (error instanceof BoundedResponseTextError) throw new MutationRequestError(
        "E_MODEL", "model response body was invalid or exceeded the safety limit",
      );
      throw error;
    }
  }

  private async postForText(
    url: string,
    init: {
      method: string; headers: Record<string, string>; body: string;
      credentials?: "include" | "omit";
    },
  ): Promise<{
    response: Pick<Response, "ok" | "status" | "body" | "headers">;
    text: string;
  }> {
    const controller = new AbortController();
    const forwardLifecycleAbort = (): void => controller.abort(this.signal?.reason);
    if (this.signal?.aborted) forwardLifecycleAbort();
    else this.signal?.addEventListener("abort", forwardLifecycleAbort, { once: true });
    const timer = globalThis.setTimeout(() =>
      controller.abort(new Error("model request deadline exceeded")), this.requestTimeoutMs);
    try {
      const response = await this.fetchFn(url, { ...init, signal: controller.signal });
      return { response, text: await this.readResponseText(response) };
    } finally {
      globalThis.clearTimeout(timer);
      this.signal?.removeEventListener("abort", forwardLifecycleAbort);
    }
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
    const { response: res, text } = await this.postForText(ANTHROPIC_API_URL, {
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

  private async openaiRequest(
    ctx: S1Context,
    repair: { priorPlanRaw: string; failures: string[] } | null,
  ): Promise<{ raw: string; usage?: { input_tokens: number; output_tokens: number } }> {
    if (this.transport.mode !== "openai")
      throw new MutationRequestError("E_NET", "not openai");
    const body = {
      model: this.transport.model ?? DEFAULT_OPENAI_MODEL,
      instructions: this.systemPrompt,
      input: this.buildMessages(ctx, repair),
      max_output_tokens: MAX_TOKENS,
      store: false,
      tools: [],
      text: { format: {
        type: "json_schema", name: "clay_mutation_plan", strict: true,
        schema: openaiApiSchema,
      } },
    };
    const endpoint = this.transport.endpoint ?? OPENAI_API_URL;
    const { response: res, text } = await this.postForText(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.transport.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok)
      throw new MutationRequestError("E_MODEL",
        `openai ${res.status}: ${text.slice(0, 400)}`);
    const parsed = JSON.parse(text) as OpenAIResponse;
    if (parsed.status === "incomplete")
      throw new MutationRequestError("E_MODEL", "OpenAI response was incomplete");
    const blocks = (parsed.output ?? []).flatMap(item => item.content ?? []);
    const refusal = blocks.find(block => block.type === "refusal")?.refusal;
    if (refusal)
      throw new MutationRequestError("E_MODEL", `OpenAI refused the request: ${refusal}`);
    const raw = blocks.find(block => block.type === "output_text")?.text;
    if (!raw)
      throw new MutationRequestError("E_MODEL", "no output_text in OpenAI response");
    return parsed.usage ? { raw, usage: parsed.usage } : { raw };
  }

  private async hostedRequest(
    endpoint: string,
    ctx: S1Context,
    repair: { priorPlanRaw: string; failures: string[] } | null,
  ): Promise<string> {
    // Doc 07 §1: the backend assembles the prompt; the wire carries schema
    // shapes + intent only (B2). Repairs count against the same attempt.
    const path = repair ? "/mutations/repair" : "/mutations/plan";
    const session = this.transport.mode === "hosted" ? this.transport.session : undefined;
    const contextJson = JSON.stringify(ctx);
    let repairCapability: string | null = null;
    if (repair) {
      const minted = this.hostedRepairCapability;
      this.hostedRepairCapability = null;
      if (minted?.endpoint === endpoint && minted.contextJson === contextJson
          && minted.priorPlanRaw === repair.priorPlanRaw) repairCapability = minted.token;
    } else {
      // A later plan supersedes any capability from an earlier attempt.
      this.hostedRepairCapability = null;
    }
    const { response: res, text } = await this.postForText(`${endpoint}${path}`, {
      method: "POST",
      credentials: this.transport.mode === "hosted" && this.transport.credentials === "include"
        ? "include" : "omit",
      headers: { "content-type": "application/json",
        ...(session ? { authorization: `Bearer ${session}` } : {}),
        ...(repairCapability
          ? { "x-clay-repair-capability": repairCapability } : {}) },
      body: JSON.stringify(repair
        ? { context: ctx, prior_plan: repair.priorPlanRaw, failures: repair.failures }
        : { context: ctx }),
    });
    if (!res.ok)
      throw new MutationRequestError("E_MODEL",
        `backend ${res.status}: ${text.slice(0, 400)}`);
    if (!repair) {
      const capability = res.headers.get("x-clay-repair-capability");
      if (capability && /^[a-f0-9]{48}$/.test(capability)) {
        this.hostedRepairCapability = Object.freeze({
          endpoint, contextJson, priorPlanRaw: text, token: capability,
        });
      }
    }
    return text;
  }
}
