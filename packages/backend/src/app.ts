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
import { timingSafeEqual } from "node:crypto";
import {
  DEFAULT_MODEL, DEFAULT_OPENAI_MODEL, MutationClient, type S1Context,
} from "@clay/mutation";
import {
  FREE_QUOTA, MemoryAuthStore, Sessions, type AuthStore, type SessionStore,
} from "./auth";

const BODY_CAP = 64 * 1024;   // doc 07: body <= 64KB

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
};

export function makeDevAuth(): NonNullable<BackendOptions["auth"]> {
  return { store: new MemoryAuthStore(), sessions: new Sessions(), devLinks: true };
}

export function createApp(opts: BackendOptions): Hono {
  if (opts.auth && !opts.auth.devLinks && !opts.auth.sendEmail)
    throw new Error("magic-link delivery is not configured");
  const app = new Hono();
  const configuredModel: ModelConfig | null = opts.model
    ?? (opts.apiKey ? { provider: "anthropic", apiKey: opts.apiKey, model: DEFAULT_MODEL } : null);
  const origins = new Set(opts.allowedOrigins ?? []);
  const recentMutations: number[] = [];
  let activeMutations = 0;
  app.use("/*", cors({
    origin: (o) => origins.size === 0 ? (o ?? "*") : (o && origins.has(o) ? o : ""),
    credentials: true,
    allowMethods: ["POST", "GET", "OPTIONS"],
  }));

  const readBody = async (c: Context): Promise<unknown> => {
    const len = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(len) && len > BODY_CAP)
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
      if (total > BODY_CAP) {
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
    if (opts.mutationRate) {
      const now = Date.now();
      while (recentMutations[0] !== undefined
          && recentMutations[0] <= now - opts.mutationRate.windowMs) recentMutations.shift();
      if (recentMutations.length >= opts.mutationRate.max)
        return c.json({ error: "too many mutation requests" }, 429);
      recentMutations.push(now);
    }
    return null;
  };
  const withMutationSlot = async (
    c: Context,
    run: () => Promise<Response>,
  ): Promise<Response> => {
    const limit = opts.mutationConcurrency ?? Number.POSITIVE_INFINITY;
    if (activeMutations >= limit)
      return c.json({ error: "another mutation is already running" }, 429);
    activeMutations++;
    try { return await run(); }
    finally { activeMutations--; }
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

  // ---------- Phase 1.2: magic-link auth + quotas (doc 07 §1–3) ----------
  const auth = opts.auth;
  const sessionId = (c: Context): string | null => {
    const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    return bearer ?? getCookie(c, "clay_session") ?? null;
  };
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
    app.post("/auth/magic-link", async (c) => {
      let body: { email?: string } | null = null;
      try { body = (await readBody(c)) as { email?: string }; }
      catch (e) { if (e instanceof Response) return e; return c.json({ error: "bad JSON" }, 400); }
      const email = body?.email?.trim().toLowerCase();
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
        return c.json({ error: "a real email address is required" }, 400);
      const token = await auth.sessions.issueLink(await auth.store.upsertUser(email));
      if (!token) return c.json({ error: "too many links — try again in an hour" }, 429);
      const link = `/auth/callback?token=${token}`;
      if (auth.devLinks) return c.json({ link });         // dev/tests: no email hop
      await auth.sendEmail?.(email, link);
      return c.body(null, 204);
    });

    app.get("/auth/callback", async (c) => {
      // an email click is a browser navigation (Accept: text/html): land
      // in the app itself, cookie set — never a raw JSON page. Fetch
      // callers (dev auto-redeem, tests) keep the JSON + bearer echo.
      const wantsHtml = c.req.header("accept")?.includes("text/html") ?? false;
      const sid = await auth.sessions.redeem(c.req.query("token") ?? "");
      if (!sid) return wantsHtml
        ? c.redirect("/?auth=expired", 302)
        : c.json({ error: "link expired — request a fresh one" }, 401);
      writeSessionCookie(c, sid, 30 * 86400);
      if (wantsHtml) return c.redirect("/?auth=ok", 302);
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
      await auth.sessions.revoke(sessionId(c));
      writeSessionCookie(c, "", 0);
      return c.body(null, 204);
    });
  }

  /** Plan calls are metered; repairs are free (they're Clay's failure, not
   * the user's). Returns a Response to short-circuit, or null to proceed. */
  const guard = async (c: Context, metered: boolean): Promise<Response | null> => {
    if (!auth) return null;                              // Phase 1.1 open mode
    const userId = await sessionUser(c);
    const user = userId ? await auth.store.getUser(userId) : null;
    if (!user) return c.json({ error: "sign in first" }, 401);
    if (metered && user.plan !== "pro") {
      const consumed = await auth.store.consumeUsage(user.id, FREE_QUOTA);
      if (!consumed.allowed)
        return c.json({
          error: `free plan is ${FREE_QUOTA} reshapes per 30 days — resets `
            + new Date(consumed.usage.periodStart + 30 * 86_400_000).toISOString().slice(0, 10),
          mutations_used: consumed.usage.used, quota: FREE_QUOTA,
        }, 429);
    }
    return null;
  };

  app.post("/mutations/plan", async (c) => {
    const requestDenied = mutationRequestGuard(c);
    if (requestDenied) return requestDenied;
    const denied = await guard(c, true);
    if (denied) return denied;
    let body: { context?: S1Context };
    try { body = (await readBody(c)) as typeof body; }
    catch (e) { if (e instanceof Response) return e; return c.json({ error: "bad JSON" }, 400); }
    if (!body?.context) return c.json({ error: "missing context" }, 400);
    return withMutationSlot(c, async () => {
      try {
        const raw = await client().rawPlan(body.context!);
        return c.body(raw, 200, { "content-type": "application/json" });
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
      }
    });
  });

  app.post("/mutations/repair", async (c) => {
    const requestDenied = mutationRequestGuard(c);
    if (requestDenied) return requestDenied;
    const denied = await guard(c, false);   // repairs never double-charge (doc 07 §3)
    if (denied) return denied;
    let body: { context?: S1Context; prior_plan?: string; failures?: string[] };
    try { body = (await readBody(c)) as typeof body; }
    catch (e) { if (e instanceof Response) return e; return c.json({ error: "bad JSON" }, 400); }
    if (!body?.context || typeof body.prior_plan !== "string")
      return c.json({ error: "missing context or prior_plan" }, 400);
    return withMutationSlot(c, async () => {
      try {
        const raw = await client().rawRepair(
          body.context!, body.prior_plan!, body.failures ?? [],
        );
        return c.body(raw, 200, { "content-type": "application/json" });
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
      }
    });
  });

  return app;
}
