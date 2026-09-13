// The hosted mutation proxy (doc 07, Phase 1.1). Thin: it assembles the
// prompt server-side and calls the model with a server-held key, so users
// need no browser key (ADR-011). Records never reach it — the body is the
// S1 context (schema shapes + intent) only (B2, ADR-009).
//
// It relays the model's RAW output; the client (worker) runs hydrate + Zod
// + the repair loop, calling /mutations/repair per round. This diverges
// from doc 07's "validate + never relay malformed" because the pipeline is
// client-orchestrated (OPEN-QUESTIONS Q24); it is safe because the client
// validates before executing anything.
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { getCookie, setCookie } from "hono/cookie";
import { createHash, timingSafeEqual } from "node:crypto";
import { extractAcornStaticStrings } from "@clay/kernel/static-javascript-strings";
import {
  IntakeFormId,
  IntakeRelayFormRegistrationV1,
  IntakeRelaySubmissionV1,
  IntakeSubmissionId,
  IntakeToken,
  MAX_INTAKE_CIPHERTEXT_BYTES,
} from "@clay/schema/intake";
import {
  SHARE_CREATE_BODY_BYTES_V1, SHARE_MAX_CIPHERTEXT_BYTES_V1,
  SHARE_MAX_LIFETIME_MS_V1, ShareCreateRequestV1, ShareIdV1,
  ShareRevokeRequestV1, ShareTerminalRequestV1,
} from "@clay/schema/share";
import {
  IntakeRelayError,
  MAX_INTAKE_DELIVERY_PAGE_BYTES,
  type IntakeRelayStore,
} from "./intake-relay";
import {
  MemoryShareRelayStore, type ShareRelayStore,
} from "./share-store";
import {
  DEFAULT_MODEL, DEFAULT_OPENAI_MODEL, MutationClient, type S1Context,
} from "@clay/mutation";
import {
  DEFAULT_MAGIC_LINK_LIMITS, DEFAULT_MUTATION_CALL_LIMITS, FREE_QUOTA,
  MemoryAuthStore, Sessions, type AuthStore, type MagicLinkLimits,
  type MutationCallLimits, type RepairCapabilityBinding, type SessionStore,
} from "./auth";

const BODY_CAP = 64 * 1024;   // doc 07: body <= 64KB
const BROWSER_PROVIDER_BODY_CAP = 64 * 1024;
const PROVIDER_SCAN_WORK_LIMIT = 16 * 1024 * 1024;

export type ModelProvider = "anthropic" | "openai" | "codex";
export type ModelConfig = { provider: ModelProvider; apiKey?: string; model?: string };

export type BackendOptions = {
  apiKey?: string;
  model?: ModelConfig;
  modelStatus?: () => {
    model: boolean; provider?: string; model_id?: string;
    reachable?: boolean; detail?: string;
  };
  /** injectable for tests; defaults to a real MutationClient */
  makeClient?: (model: ModelConfig) => Pick<MutationClient, "rawPlan" | "rawRepair">;
  /** Phase 1.2: providing an auth store turns on auth + quotas. Omitted =
   * Phase 1.1 open local proxy (first-class dev mode, doc 07 §6 spirit). */
  auth?: { store: AuthStore; sessions: SessionStore;
    /** dev mode: return the magic link in the response instead of email —
     * an email provider is a deploy-time concern (OPEN-QUESTIONS) */
    devLinks?: boolean;
    sendEmail?: (email: string, link: string) => Promise<void> };
  /** Production deployments pin CORS to their known shell origin. */
  allowedOrigins?: string[];
  mutationToken?: string;
  exposeMutationTokenOnHealth?: boolean;
  requireAllowedMutationOrigin?: boolean;
  mutationRate?: { max: number; windowMs: number };
  mutationConcurrency?: number;
  magicLinkRate?: MagicLinkLimits;
  /** F1 relay: ciphertext + bounded delivery metadata only. */
  shares?: ShareRelayStore;
  /** Injectable clock for expiry-boundary tests. */
  now?: () => number;
  /** Ciphertext-only public intake relay. Omitted keeps all intake routes absent. */
  intakeRelay?: IntakeRelayStore;
  /** Per-process edge controls complement the relay store's transactional durable quotas. */
  intakeRate?: { maxRequests: number; maxBytes: number; windowMs: number };
  intakeConcurrency?: number;
  /** Deployment scheduler capability for durable relay TTL cleanup. */
  intakeCleanupToken?: string;
};

export function makeDevAuth(): NonNullable<BackendOptions["auth"]> {
  return { store: new MemoryAuthStore(), sessions: new Sessions(), devLinks: true };
}

export function createApp(opts: BackendOptions): Hono {
  if (opts.auth && !opts.auth.devLinks && !opts.auth.sendEmail)
    throw new Error("magic-link delivery is not configured");
  if (opts.intakeCleanupToken !== undefined
      && (opts.intakeCleanupToken.length < 16 || opts.intakeCleanupToken.length > 256))
    throw new Error("intake cleanup capability must be 16 to 256 characters");
  const app = new Hono();
  const configuredModel: ModelConfig | null = opts.model
    ?? (opts.apiKey ? { provider: "anthropic", apiKey: opts.apiKey, model: DEFAULT_MODEL } : null);
  const origins = new Set(opts.allowedOrigins ?? []);
  const shares = opts.shares ?? new MemoryShareRelayStore();
  const now = opts.now ?? Date.now;
  app.use("/*", cors({
    origin: (o) => origins.size === 0 ? (o ?? "*") : (o && origins.has(o) ? o : ""),
    credentials: true,
    allowMethods: ["POST", "GET", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "x-clay-repair-capability"],
    exposeHeaders: ["x-clay-repair-capability"],
  }));

  const readBody = async (c: Context, cap = BODY_CAP): Promise<unknown> => {
    const len = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(len) && len > cap)
      throw new Response("body too large", { status: 413 });
    const stream = c.req.raw.body;
    if (!stream) throw new SyntaxError("empty body");
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel("body too large");
        throw new Response("body too large", { status: 413 });
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  };

  const canonicalJson = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  };
  const digest = (value: string): string =>
    createHash("sha256").update(value, "utf8").digest("hex");
  const protectedProviderSecrets = [configuredModel?.apiKey, opts.mutationToken]
    .filter((secret): secret is string => typeof secret === "string" && secret.length > 0);
  const reflectsProviderSecret = (text: string): boolean => {
    if (protectedProviderSecrets.length === 0) return false;
    const forms = new Set<string>();
    for (const secret of protectedProviderSecrets) {
      const bytes = Buffer.from(secret, "utf8");
      const base64 = bytes.toString("base64");
      const hex = bytes.toString("hex");
      const percent = [...bytes]
        .map(byte => `%${byte.toString(16).padStart(2, "0")}`).join("");
      for (const form of [
        secret, base64, base64.replace(/=+$/, ""), hex, hex.toUpperCase(),
        percent, percent.toUpperCase(),
      ]) forms.add(form);
    }
    const formsList = [...forms];
    const queue: string[] = [];
    const seen = new Set<string>();
    let work = 0;
    let overflow = false;
    const enqueue = (candidate: string): void => {
      if (!candidate || seen.has(candidate)) return;
      work += Buffer.byteLength(candidate, "utf8");
      if (work > PROVIDER_SCAN_WORK_LIMIT) { overflow = true; return; }
      seen.add(candidate);
      queue.push(candidate);
    };
    enqueue(text);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      if (overflow) return true;
      const candidate = queue[cursor]!;
      if (formsList.some(form => candidate.includes(form))) return true;

      let escaped = candidate
        .replace(/\\x([0-9a-f]{2})/gi, (_match, hexValue: string) =>
          String.fromCharCode(Number.parseInt(hexValue, 16)))
        .replace(/\\u\{([0-9a-f]{1,6})\}/gi, (_match, hexValue: string) => {
          const point = Number.parseInt(hexValue, 16);
          return point <= 0x10ffff ? String.fromCodePoint(point) : "";
        })
        .replace(/\\u([0-9a-f]{4})/gi, (_match, hexValue: string) =>
          String.fromCharCode(Number.parseInt(hexValue, 16)))
        .replace(/\\\\/g, "\\");
      if (escaped !== candidate) enqueue(escaped);
      try {
        escaped = decodeURIComponent(candidate);
        if (escaped !== candidate) enqueue(escaped);
      } catch { /* malformed percent data */ }

      const staticStrings = extractAcornStaticStrings(candidate);
      if (staticStrings === null) return true;
      for (const value of staticStrings) enqueue(value);

      try {
        const pending: unknown[] = [JSON.parse(candidate) as unknown];
        let nodes = 0;
        while (pending.length > 0) {
          if (++nodes > 100_000) return true;
          const value = pending.pop();
          if (typeof value === "string") enqueue(value);
          else if (Array.isArray(value)) {
            for (const item of value) pending.push(item);
          } else if (value && typeof value === "object") {
            for (const item of Object.values(value as Record<string, unknown>)) pending.push(item);
          }
        }
      } catch { /* candidate is not standalone JSON */ }
    }
    return overflow;
  };
  const confinedProviderBody = (raw: unknown): string | null =>
    typeof raw === "string"
      && Buffer.byteLength(raw, "utf8") <= BROWSER_PROVIDER_BODY_CAP
      && !reflectsProviderSecret(raw) ? raw : null;
  const providerFailure = (c: Context): Response =>
    c.json({ error: "model request failed" }, 502);
  const magicLinkSourceDigest = (c: Context): string => {
    const forwarded = c.req.header("cf-connecting-ip")
      ?? c.req.header("x-real-ip")
      ?? c.req.header("x-forwarded-for")?.split(",", 1)[0]
      ?? "unknown";
    return digest(`magic-link-source:${forwarded.trim().toLowerCase().slice(0, 256)}`);
  };

  const tokenMatches = (candidate: string | null): boolean => {
    if (!opts.mutationToken || !candidate) return false;
    const expected = Buffer.from(opts.mutationToken);
    const actual = Buffer.from(candidate);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  };
  const mutationRequestGuard = (c: Context): Response | null => {
    const contentType = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json")
      return c.json({ error: "content-type must be application/json" }, 415);
    if (opts.mutationToken) {
      const bearer = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
      if (!tokenMatches(bearer)) return c.json({ error: "connector token required" }, 401);
    }
    if (opts.requireAllowedMutationOrigin) {
      const origin = c.req.header("origin");
      const site = c.req.header("sec-fetch-site");
      if ((origin && !origins.has(origin)) || site === "cross-site")
        return c.json({ error: "origin is not allowed" }, 403);
    }
    return null;
  };
  const mutationAuthority = opts.auth?.sessions ?? new Sessions();
  const mutationLimits: MutationCallLimits = Object.freeze({
    ...DEFAULT_MUTATION_CALL_LIMITS,
    ...(opts.mutationRate ? {
      windowMs: opts.mutationRate.windowMs,
      maxPerUser: opts.mutationRate.max,
      maxGlobal: opts.mutationRate.max,
    } : {}),
    ...(opts.mutationConcurrency !== undefined ? {
      maxConcurrentPerUser: opts.mutationConcurrency,
      maxConcurrentGlobal: opts.mutationConcurrency,
    } : {}),
  });
  const withMutationSlot = async (
    c: Context,
    userId: string,
    run: () => Promise<Response>,
  ): Promise<Response> => {
    const lease = await mutationAuthority.acquireMutationCall(userId, mutationLimits);
    if (!lease) return c.json({ error: "mutation capacity is temporarily exhausted" }, 429);
    try { return await run(); }
    finally { await mutationAuthority.releaseMutationCall(lease); }
  };

  const client = (): Pick<MutationClient, "rawPlan" | "rawRepair"> => {
    if (!configuredModel) throw new Error("server is not configured with a model provider");
    if (opts.makeClient) return opts.makeClient(configuredModel);
    if (!configuredModel.apiKey)
      throw new Error(`${configuredModel.provider} requires a configured model credential`);
    return configuredModel.provider === "openai"
      ? new MutationClient({ mode: "openai", apiKey: configuredModel.apiKey,
          model: configuredModel.model ?? DEFAULT_OPENAI_MODEL }, { modelRepair: true })
      : new MutationClient({ mode: "byo", apiKey: configuredModel.apiKey }, { modelRepair: true });
  };

  app.get("/healthz", (c) => {
    c.header("Cache-Control", "no-store");
    const origin = c.req.header("origin");
    const exposeConnectorToken = Boolean(
      opts.exposeMutationTokenOnHealth && opts.mutationToken && origin
      && opts.allowedOrigins?.includes(origin),
    );
    return c.json({ ok: true,
      ...(opts.modelStatus?.() ?? {
        model: Boolean(configuredModel),
        ...(opts.model ? { provider: configuredModel?.provider,
          model_id: configuredModel?.model ?? (configuredModel?.provider === "openai"
            ? DEFAULT_OPENAI_MODEL : DEFAULT_MODEL) } : {}),
      }),
      ...(exposeConnectorToken ? { connector_token: opts.mutationToken } : {}),
    });
  });

  // ---------- Release F: bounded ciphertext-only public intake relay ----------
  const intakeRelay = opts.intakeRelay;
  if (intakeRelay) {
    const intakeBodyCap = Math.ceil(MAX_INTAKE_CIPHERTEXT_BYTES * 4 / 3) + 16 * 1024;
    const intakeRate = opts.intakeRate ?? {
      maxRequests: 60, maxBytes: 64 * 1024 * 1024, windowMs: 60_000,
    };
    const intakeConcurrency = opts.intakeConcurrency ?? 4;
    if (![intakeRate.maxRequests, intakeRate.maxBytes, intakeRate.windowMs, intakeConcurrency]
      .every(value => Number.isSafeInteger(value) && value > 0))
      throw new Error("intake request limits must be positive integers");
    const intakeEvents = new Map<string, Array<{ at: number; bytes: number }>>();
    let activeIntakeSubmissions = 0;
    const tokenHash = (token: string): string =>
      createHash("sha256").update(token, "utf8").digest("hex");
    const bearerToken = (c: Context): string | null => {
      const match = c.req.header("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/u);
      if (!match || !IntakeToken.safeParse(match[1]).success) return null;
      return match[1]!;
    };
    const jsonContent = (c: Context): boolean =>
      c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
    const requestSource = (c: Context): string => {
      const forwarded = c.req.header("cf-connecting-ip")
        ?? c.req.header("x-real-ip")
        ?? c.req.header("x-forwarded-for")?.split(",", 1)[0]
        ?? "unknown";
      const canonical = forwarded.trim().toLowerCase();
      return canonical.length > 0 && canonical.length <= 128 ? canonical : "unknown";
    };
    const reserveIntakeRate = (c: Context, bodyCap: number): Response | null => {
      const now = Date.now();
      const source = tokenHash(requestSource(c));
      const recent = (intakeEvents.get(source) ?? [])
        .filter(event => event.at > now - intakeRate.windowMs);
      const declaredText = c.req.header("content-length");
      const declared = declaredText === undefined ? bodyCap : Number(declaredText);
      if (!Number.isSafeInteger(declared) || declared < 1 || declared > bodyCap)
        return c.json({ error: "body too large" }, 413);
      const bytes = recent.reduce((total, event) => total + event.bytes, 0);
      if (recent.length >= intakeRate.maxRequests || bytes + declared > intakeRate.maxBytes)
        return c.json({ error: "intake submission rate limit reached" }, 429);
      recent.push({ at: now, bytes: declared });
      intakeEvents.set(source, recent);
      return null;
    };
    const ciphertextByteLength = (value: string): number => {
      if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid ciphertext encoding");
      const bytes = Buffer.from(value, "base64url");
      if (bytes.toString("base64url") !== value) throw new Error("non-canonical ciphertext encoding");
      return bytes.byteLength;
    };
    const relayFailure = (c: Context, error: unknown): Response => {
      if (!(error instanceof IntakeRelayError))
        return c.json({ error: "intake relay failed safely" }, 500);
      switch (error.relayCode) {
        case "unauthorized": return c.json({ error: error.message }, 401);
        case "not_found": return c.json({ error: error.message }, 404);
        case "expired": return c.json({ error: error.message }, 410);
        case "conflict": return c.json({ error: error.message }, 409);
        case "item_too_large": return c.json({ error: error.message }, 413);
        case "queue_full": case "capacity": return c.json({ error: error.message }, 429);
        case "invalid": return c.json({ error: error.message }, 400);
      }
    };

    const cleanupTokenMatches = (candidate: string | null): boolean => {
      if (!opts.intakeCleanupToken || !candidate || candidate.length > 256) return false;
      const expected = createHash("sha256").update(opts.intakeCleanupToken, "utf8").digest();
      const actual = createHash("sha256").update(candidate, "utf8").digest();
      return timingSafeEqual(expected, actual);
    };
    if (opts.intakeCleanupToken) app.get("/internal/intake/cleanup", async (c) => {
      c.header("Cache-Control", "no-store");
      const candidate = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/iu)?.[1] ?? null;
      if (!cleanupTokenMatches(candidate)) return c.json({ error: "cleanup capability required" }, 401);
      try { return c.json({ ok: true, ...(await intakeRelay.cleanupExpired()) }); }
      catch { return c.json({ error: "intake cleanup failed safely" }, 500); }
    });

    app.post("/intake/forms", async (c) => {
      c.header("Cache-Control", "no-store");
      if (!jsonContent(c)) return c.json({ error: "content-type must be application/json" }, 415);
      const publisherId = auth ? await sessionUser(c) : null;
      if (!publisherId) return c.json({ error: "sign in before publishing a form" }, 401);
      const origin = c.req.header("origin");
      if (!origin || !origins.has(origin)) return c.json({ error: "intake publisher origin is not configured" }, 403);
      let raw: unknown;
      try { raw = await readBody(c, 8 * 1024); }
      catch (error) {
        if (error instanceof Response) return error;
        return c.json({ error: "bad JSON" }, 400);
      }
      const parsed = IntakeRelayFormRegistrationV1.safeParse(raw);
      if (!parsed.success) return c.json({ error: "invalid intake form registration" }, 400);
      try {
        const result = await intakeRelay.register({
          formId: parsed.data.formId,
          ownerTokenSha256: tokenHash(parsed.data.ownerToken),
          submitTokenSha256: tokenHash(parsed.data.submitToken),
          publisherIdSha256: tokenHash(publisherId),
          sourceSha256: tokenHash(requestSource(c)),
          expiresAt: parsed.data.expiresAt,
          maxCiphertextBytes: parsed.data.maxCiphertextBytes,
        });
        return c.json({ formId: parsed.data.formId, expiresAt: parsed.data.expiresAt },
          result.created ? 201 : 200);
      } catch (error) { return relayFailure(c, error); }
    });

    app.post("/intake/forms/:formId/terminalize", async (c) => {
      c.header("Cache-Control", "no-store");
      const publisherId = auth ? await sessionUser(c) : null;
      if (!publisherId) return c.json({ error: "original publisher authority required" }, 401);
      const origin = c.req.header("origin");
      if (!origin || !origins.has(origin)) return c.json({ error: "intake publisher origin is not configured" }, 403);
      if (!jsonContent(c)) return c.json({ error: "content-type must be application/json" }, 415);
      let raw: unknown;
      try { raw = await readBody(c, 8 * 1024); }
      catch (error) { return error instanceof Response ? error : c.json({ error: "bad JSON" }, 400); }
      const parsed = IntakeRelayFormRegistrationV1.safeParse(raw);
      if (!parsed.success || parsed.data.formId !== c.req.param("formId")) return c.json({ error: "invalid terminal identity" }, 400);
      try {
        await intakeRelay.terminalize({ formId: parsed.data.formId,
          ownerTokenSha256: tokenHash(parsed.data.ownerToken), submitTokenSha256: tokenHash(parsed.data.submitToken),
          publisherIdSha256: tokenHash(publisherId), sourceSha256: tokenHash(requestSource(c)),
          expiresAt: parsed.data.expiresAt, maxCiphertextBytes: parsed.data.maxCiphertextBytes });
        return c.json({ schema: 1, formId: parsed.data.formId, expiresAt: parsed.data.expiresAt,
          requestSha256: tokenHash(JSON.stringify(parsed.data)), terminal: true });
      } catch (error) { return relayFailure(c, error); }
    });

    app.post("/intake/forms/:formId/submissions", async (c) => {
      c.header("Cache-Control", "no-store");
      const form = IntakeFormId.safeParse(c.req.param("formId"));
      const token = bearerToken(c);
      if (!form.success) return c.json({ error: "intake form was not found" }, 404);
      if (!token) return c.json({ error: "submit capability required" }, 401);
      if (!jsonContent(c)) return c.json({ error: "content-type must be application/json" }, 415);
      let authorized: { maxCiphertextBytes: number };
      try { authorized = await intakeRelay.authorizeSubmission(form.data, tokenHash(token)); }
      catch (error) { return relayFailure(c, error); }
      const authorizedBodyCap = Math.min(
        intakeBodyCap,
        Math.ceil(authorized.maxCiphertextBytes * 4 / 3) + 16 * 1024,
      );
      const rateDenied = reserveIntakeRate(c, authorizedBodyCap);
      if (rateDenied) return rateDenied;
      if (activeIntakeSubmissions >= intakeConcurrency)
        return c.json({ error: "too many concurrent intake submissions" }, 429);
      activeIntakeSubmissions++;
      try {
        let raw: unknown;
        try { raw = await readBody(c, authorizedBodyCap); }
        catch (error) {
          if (error instanceof Response) return error;
          return c.json({ error: "bad JSON" }, 400);
        }
        const parsed = IntakeRelaySubmissionV1.safeParse(raw);
        if (!parsed.success) return c.json({ error: "invalid encrypted submission" }, 400);
        let ciphertextBytes: number;
        try { ciphertextBytes = ciphertextByteLength(parsed.data.envelope.ciphertext); }
        catch { return c.json({ error: "invalid encrypted submission" }, 400); }
        try {
          const result = await intakeRelay.putSubmission(tokenHash(token), {
            formId: form.data,
            submissionId: parsed.data.submissionId,
            envelope: parsed.data.envelope,
            ciphertextBytes,
          });
          return c.json({ submissionId: result.item.submissionId,
            receivedAt: result.item.receivedAt }, result.created ? 201 : 200);
        } catch (error) { return relayFailure(c, error); }
      } finally { activeIntakeSubmissions--; }
    });

    app.get("/intake/forms/:formId/submissions", async (c) => {
      c.header("Cache-Control", "no-store");
      const form = IntakeFormId.safeParse(c.req.param("formId"));
      const token = bearerToken(c);
      if (!form.success) return c.json({ error: "intake form was not found" }, 404);
      if (!token) return c.json({ error: "owner capability required" }, 401);
      const limitText = c.req.query("limit") ?? "25";
      if (!/^(?:[1-9]|[1-4][0-9]|50)$/u.test(limitText))
        return c.json({ error: "list limit must be between 1 and 50" }, 400);
      const afterText = c.req.query("after") ?? null;
      if (afterText !== null && !IntakeSubmissionId.safeParse(afterText).success)
        return c.json({ error: "list cursor is invalid" }, 400);
      try {
        return c.json(await intakeRelay.listSubmissions(
          form.data, tokenHash(token), Number(limitText), afterText,
          MAX_INTAKE_DELIVERY_PAGE_BYTES,
        ));
      } catch (error) { return relayFailure(c, error); }
    });

    app.delete("/intake/forms/:formId/submissions/:submissionId", async (c) => {
      c.header("Cache-Control", "no-store");
      const form = IntakeFormId.safeParse(c.req.param("formId"));
      const submission = IntakeSubmissionId.safeParse(c.req.param("submissionId"));
      const token = bearerToken(c);
      if (!form.success || !submission.success)
        return c.json({ error: "intake delivery was not found" }, 404);
      if (!token) return c.json({ error: "owner capability required" }, 401);
      try {
        const removed = await intakeRelay.deleteSubmission(
          form.data, submission.data, tokenHash(token),
        );
        return removed ? c.body(null, 204) : c.json({ error: "intake delivery was not found" }, 404);
      } catch (error) { return relayFailure(c, error); }
    });

    app.delete("/intake/forms/:formId", async (c) => {
      c.header("Cache-Control", "no-store");
      const form = IntakeFormId.safeParse(c.req.param("formId"));
      const token = bearerToken(c);
      if (!form.success) return c.json({ error: "intake form was not found" }, 404);
      if (!token) return c.json({ error: "owner capability required" }, 401);
      try {
        await intakeRelay.revokeForm(form.data, tokenHash(token));
        return c.body(null, 204);
      } catch (error) { return relayFailure(c, error); }
    });
  }

  // ---------- Phase 1.2: magic-link auth + quotas (doc 07 §1–3) ----------
  const auth = opts.auth;
  const bearerSessionId = (c: Context): string | null =>
    c.req.header("authorization")?.match(/^Bearer\s+([^\s]+)$/i)?.[1] ?? null;
  const cookieSessionId = (c: Context): string | null => getCookie(c, "clay_session") ?? null;
  const sessionId = (c: Context): string | null => bearerSessionId(c) ?? cookieSessionId(c);
  const writeSessionCookie = (c: Context, sid: string, maxAge: number): void =>
    setCookie(c, "clay_session", sid, {
      httpOnly: true, sameSite: "Lax", secure: new URL(c.req.url).protocol === "https:",
      path: "/", maxAge,
    });
  const sessionUser = async (c: Context): Promise<string | null> => {
    if (!auth) return null;
    const sid = sessionId(c);
    const userId = await auth.sessions.userIdFor(sid);
    if (userId && sid && getCookie(c, "clay_session") === sid)
      writeSessionCookie(c, sid, 30 * 86400);   // browser expiry rolls with server expiry
    return userId;
  };

  if (auth) {
    const authState = /^[0-9a-f]{64}$/;
    const magicLinkLimits = Object.freeze(opts.magicLinkRate ?? DEFAULT_MAGIC_LINK_LIMITS);
    app.post("/auth/magic-link", async (c) => {
      const contentType = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json")
        return c.json({ error: "content-type must be application/json" }, 415);
      const origin = c.req.header("origin");
      const site = c.req.header("sec-fetch-site");
      if (site === "cross-site" || (origins.size > 0 && (!origin || !origins.has(origin))))
        return c.json({ error: "origin is not allowed" }, 403);
      let body: { email?: string; state?: string } | null = null;
      try { body = (await readBody(c)) as { email?: string; state?: string }; }
      catch (e) { if (e instanceof Response) return e; return c.json({ error: "bad JSON" }, 400); }
      const email = body?.email?.trim().toLowerCase();
      const state = body?.state ?? "";
      if (!email || email.length > 254 || email.split("@", 1)[0]!.length > 64
          || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
        return c.json({ error: "a real email address is required" }, 400);
      if (!authState.test(state)) return c.json({ error: "invalid authentication state" }, 400);
      const token = await auth.sessions.issueLink(
        email, magicLinkSourceDigest(c), magicLinkLimits,
      );
      if (!token) return c.json({ error: "too many links — try again in an hour" }, 429);
      const link = `/auth/callback?token=${encodeURIComponent(token)}&state=${state}`;
      if (auth.devLinks) return c.json({ link });         // dev/tests: no email hop
      try { await auth.sendEmail?.(email, link); }
      catch {
        await auth.sessions.discardLink(token);
        return c.json({ error: "sign-in email could not be delivered" }, 502);
      }
      return c.body(null, 204);
    });

    app.get("/auth/callback", async (c) => {
      // An email click receives a fragment handoff without redeeming. Only a
      // state-validated app fetch redeems the token and receives the bearer.
      const wantsHtml = c.req.header("accept")?.includes("text/html") ?? false;
      const token = c.req.query("token") ?? "";
      const state = c.req.query("state") ?? "";
      if (!authState.test(state)) return wantsHtml
        ? c.redirect("/#auth=invalid", 302)
        : c.json({ error: "invalid authentication state" }, 400);
      if (wantsHtml) return c.redirect(
        `/#auth=complete&token=${encodeURIComponent(token)}&state=${state}`, 302,
      );
      const email = await auth.sessions.consumeLink(token);
      if (!email) return c.json({ error: "link expired — request a fresh one" }, 401);
      const user = await auth.store.upsertUser(email);
      const sid = await auth.sessions.createSession(user.id);
      writeSessionCookie(c, sid, 30 * 86400);
      // bearer echo: lets a cross-origin client store the session itself
      return c.json({ ok: true, session: sid });
    });

    app.get("/me", async (c) => {
      const userId = await sessionUser(c);
      const user = userId ? await auth.store.getUser(userId) : null;
      if (!user) return c.json({ error: "sign in first" }, 401);
      const usage = await auth.store.usage(user.id);
      return c.json({
        user_id: user.id, email: user.email, plan: user.plan,
        mutations_used: usage.used,
        quota: user.plan === "pro" ? null : FREE_QUOTA,
        period_end: new Date(usage.periodStart + 30 * 86_400_000).toISOString(),
      });
    });

    app.post("/auth/logout", async (c) => {
      const presented = [bearerSessionId(c), cookieSessionId(c)]
        .filter((sid): sid is string => Boolean(sid));
      await auth.sessions.revokeMany([...new Set(presented)]);
      writeSessionCookie(c, "", 0);
      return c.body(null, 204);
    });
  }

  // ---------- F1: bounded ciphertext-only read-only shares ----------
  const noStore = (c: Context): void => c.header("Cache-Control", "no-store");
  const jsonRequest = (c: Context): boolean =>
    c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
  const decodedBase64Url = (value: string): Buffer | null => {
    try {
      const bytes = Buffer.from(value, "base64url");
      return bytes.toString("base64url") === value ? bytes : null;
    } catch { return null; }
  };
  const revokeHash = (token: string): string | null => {
    const bytes = decodedBase64Url(token);
    return bytes ? createHash("sha256").update(bytes).digest("base64url") : null;
  };

  app.post("/shares", async (c) => {
    noStore(c);
    if (!jsonRequest(c))
      return c.json({ schema: 1 as const, error: "bad_request" as const }, 415);
    const ownerId = auth ? await sessionUser(c) : null;
    if (!ownerId)
      return c.json({ schema: 1 as const, error: "unauthorized" as const }, 401);
    const origin = c.req.header("origin");
    if (!origin || !origins.has(origin))
      return c.json({ schema: 1 as const, error: "forbidden" as const }, 403);
    let unknown: unknown;
    try { unknown = await readBody(c, SHARE_CREATE_BODY_BYTES_V1); }
    catch (error) {
      if (error instanceof Response) return error;
      return c.json({ schema: 1 as const, error: "bad_request" as const }, 400);
    }
    const parsed = ShareCreateRequestV1.safeParse(unknown);
    if (!parsed.success)
      return c.json({ schema: 1 as const, error: "bad_request" as const }, 400);
    const current = now();
    const expiration = Date.parse(parsed.data.expiresAt);
    const ciphertext = decodedBase64Url(parsed.data.envelope.ciphertext);
    const iv = decodedBase64Url(parsed.data.envelope.iv);
    if (!Number.isFinite(expiration) || expiration <= current
        || expiration - current > SHARE_MAX_LIFETIME_MS_V1
        || !ciphertext || ciphertext.byteLength > SHARE_MAX_CIPHERTEXT_BYTES_V1
        || !iv || iv.byteLength !== 12)
      return c.json({ schema: 1 as const, error: "bad_request" as const }, 400);
    const result = await shares.create({
      shareId: parsed.data.shareId,
      expiresAt: parsed.data.expiresAt,
      createdAt: new Date(current).toISOString(),
      ownerId,
      revokeTokenHash: parsed.data.revokeTokenHash,
      envelope: parsed.data.envelope,
      ciphertextBytes: ciphertext.byteLength,
    }, now);
    if (result === "expired")
      return c.json({ schema: 1 as const, error: "expired" as const }, 400);
    if (result === "conflict")
      return c.json({ schema: 1 as const, error: "conflict" as const }, 409);
    if (result === "capacity")
      return c.json({ schema: 1 as const, error: "capacity" as const }, 507);
    return c.json({
      schema: 1 as const,
      shareId: parsed.data.shareId,
      expiresAt: parsed.data.expiresAt,
    }, result === "replayed" ? 200 : 201);
  });

  app.get("/shares/:shareId", async (c) => {
    noStore(c);
    const parsedId = ShareIdV1.safeParse(c.req.param("shareId"));
    if (!parsedId.success)
      return c.json({ schema: 1 as const, error: "not_found" as const }, 404);
    const lookup = await shares.lookup(parsedId.data, now());
    if (lookup.state === "not_found")
      return c.json({ schema: 1 as const, error: "not_found" as const }, 404);
    if (lookup.state === "expired")
      return c.json({ schema: 1 as const, error: "expired" as const }, 410);
    if (lookup.state === "revoked")
      return c.json({ schema: 1 as const, error: "revoked" as const }, 410);
    return c.json({
      schema: 1 as const,
      shareId: lookup.record.shareId,
      expiresAt: lookup.record.expiresAt,
      envelope: lookup.record.envelope,
    });
  });

  app.post("/shares/:shareId/terminalize", async (c) => {
    noStore(c);
    const ownerId = auth ? await sessionUser(c) : null;
    if (!ownerId) return c.json({ schema: 1, error: "unauthorized" }, 401);
    const origin = c.req.header("origin");
    if (!origin || !origins.has(origin)) return c.json({ schema: 1, error: "forbidden" }, 403);
    if (!jsonRequest(c)) return c.json({ schema: 1, error: "bad_request" }, 415);
    let raw: unknown;
    try { raw = await readBody(c, SHARE_CREATE_BODY_BYTES_V1); }
    catch (error) { return error instanceof Response ? error : c.json({ schema: 1, error: "bad_request" }, 400); }
    const parsed = ShareTerminalRequestV1.safeParse(raw);
    if (!parsed.success || parsed.data.request.shareId !== c.req.param("shareId")) return c.json({ schema: 1, error: "bad_request" }, 400);
    const request = parsed.data.request;
    if (revokeHash(parsed.data.revokeToken) !== request.revokeTokenHash) return c.json({ schema: 1, error: "forbidden" }, 403);
    const current = now(); const expiry = Date.parse(request.expiresAt);
    const ciphertext = decodedBase64Url(request.envelope.ciphertext), iv = decodedBase64Url(request.envelope.iv);
    if (!Number.isFinite(expiry) || expiry > current + SHARE_MAX_LIFETIME_MS_V1 || !ciphertext
        || ciphertext.byteLength > SHARE_MAX_CIPHERTEXT_BYTES_V1 || !iv || iv.byteLength !== 12)
      return c.json({ schema: 1, error: "bad_request" }, 400);
    const result = await shares.terminalize({ shareId: request.shareId, expiresAt: request.expiresAt,
      createdAt: new Date(current).toISOString(), ownerId, revokeTokenHash: request.revokeTokenHash,
      envelope: request.envelope, ciphertextBytes: ciphertext.byteLength }, now);
    if (result === "conflict") return c.json({ schema: 1, error: "conflict" }, 409);
    if (result === "capacity") return c.json({ schema: 1, error: "capacity" }, 507);
    return c.json({ schema: 1, shareId: request.shareId, expiresAt: request.expiresAt,
      requestSha256: createHash("sha256").update(JSON.stringify(request)).digest("hex"), terminal: true });
  });

  app.post("/shares/:shareId/revoke", async (c) => {
    noStore(c);
    const parsedId = ShareIdV1.safeParse(c.req.param("shareId"));
    if (!parsedId.success)
      return c.json({ schema: 1 as const, error: "not_found" as const }, 404);
    if (!jsonRequest(c))
      return c.json({ schema: 1 as const, error: "bad_request" as const }, 415);
    let unknown: unknown;
    try { unknown = await readBody(c); }
    catch (error) {
      if (error instanceof Response) return error;
      return c.json({ schema: 1 as const, error: "bad_request" as const }, 400);
    }
    const parsed = ShareRevokeRequestV1.safeParse(unknown);
    const candidateHash = parsed.success ? revokeHash(parsed.data.revokeToken) : null;
    if (!parsed.success || !candidateHash)
      return c.json({ schema: 1 as const, error: "bad_request" as const }, 400);
    const result = await shares.revoke(parsedId.data, candidateHash, now());
    if (result === "not_found")
      return c.json({ schema: 1 as const, error: "not_found" as const }, 404);
    if (result === "expired")
      return c.json({ schema: 1 as const, error: "expired" as const }, 410);
    if (result === "forbidden")
      return c.json({ schema: 1 as const, error: "forbidden" as const }, 403);
    return c.json({ schema: 1 as const, shareId: parsedId.data, revoked: true as const });
  });

  type MutationPrincipal = Readonly<{ userId: string; sessionDigest: string }>;
  type MutationAuthorization =
    | { principal: MutationPrincipal; denied: null }
    | { principal: null; denied: Response };
  /** Plan calls are metered; a repair proves its plan's metered principal. */
  const authorizeMutation = async (
    c: Context,
    metered: boolean,
  ): Promise<MutationAuthorization> => {
    const sid = sessionId(c);
    if (!auth) {
      const localCredential = sid ?? opts.mutationToken ?? "local-open-proxy";
      const identity = digest(localCredential);
      return { principal: { userId: `local:${identity}`, sessionDigest: identity }, denied: null };
    }
    const userId = await auth.sessions.userIdFor(sid);
    const user = userId ? await auth.store.getUser(userId) : null;
    if (!user || !sid) return { principal: null,
      denied: c.json({ error: "sign in first" }, 401) };
    if (metered && user.plan !== "pro") {
      const consumed = await auth.store.consumeUsage(user.id, FREE_QUOTA);
      if (!consumed.allowed)
        return { principal: null, denied: c.json({
          error: `free plan is ${FREE_QUOTA} reshapes per 30 days — resets `
            + new Date(consumed.usage.periodStart + 30 * 86_400_000).toISOString().slice(0, 10),
          mutations_used: consumed.usage.used, quota: FREE_QUOTA,
        }, 429) };
    }
    return { principal: { userId: user.id, sessionDigest: digest(sid) }, denied: null };
  };
  const repairBinding = (
    principal: MutationPrincipal,
    context: S1Context,
    rawPlan: string,
  ): RepairCapabilityBinding => ({
    ...principal,
    contextDigest: digest(canonicalJson(context)),
    planDigest: digest(rawPlan),
  });

  app.post("/mutations/plan", async (c) => {
    const requestDenied = mutationRequestGuard(c);
    if (requestDenied) return requestDenied;
    let body: { context?: S1Context };
    try { body = (await readBody(c)) as typeof body; }
    catch (e) { if (e instanceof Response) return e; return c.json({ error: "bad JSON" }, 400); }
    if (!body?.context) return c.json({ error: "missing context" }, 400);
    const authorization = await authorizeMutation(c, true);
    if (authorization.denied) return authorization.denied;
    return withMutationSlot(c, authorization.principal.userId, async () => {
      try {
        const raw = confinedProviderBody(await client().rawPlan(body.context!));
        if (raw === null) return providerFailure(c);
        const capability = await mutationAuthority.issueRepairCapability(
          repairBinding(authorization.principal, body.context!, raw),
        );
        c.header("x-clay-repair-capability", capability);
        return c.body(raw, 200, { "content-type": "application/json" });
      } catch { return providerFailure(c); }
    });
  });

  app.post("/mutations/repair", async (c) => {
    const requestDenied = mutationRequestGuard(c);
    if (requestDenied) return requestDenied;
    let body: { context?: S1Context; prior_plan?: string; failures?: string[] };
    try { body = (await readBody(c)) as typeof body; }
    catch (e) { if (e instanceof Response) return e; return c.json({ error: "bad JSON" }, 400); }
    if (!body?.context || typeof body.prior_plan !== "string")
      return c.json({ error: "missing context or prior_plan" }, 400);
    const authorization = await authorizeMutation(c, false);
    if (authorization.denied) return authorization.denied;
    const capability = c.req.header("x-clay-repair-capability") ?? "";
    if (!/^[a-f0-9]{48}$/.test(capability))
      return c.json({ error: "a bound repair capability is required" }, 403);
    return withMutationSlot(c, authorization.principal.userId, async () => {
      try {
        const consumed = await mutationAuthority.consumeRepairCapability(
          capability,
          repairBinding(authorization.principal, body.context!, body.prior_plan!),
        );
        if (!consumed) return c.json({ error: "repair capability is invalid or spent" }, 403);
        const raw = confinedProviderBody(await client().rawRepair(
          body.context!, body.prior_plan!, body.failures ?? [],
        ));
        if (raw === null) return providerFailure(c);
        return c.body(raw, 200, { "content-type": "application/json" });
      } catch { return providerFailure(c); }
    });
  });

  return app;
}
