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
import { MutationClient, type S1Context } from "@clay/mutation";
import { FREE_QUOTA, MemoryAuthStore, Sessions, type AuthStore } from "./auth";

const BODY_CAP = 64 * 1024;   // doc 07: body <= 64KB

export type BackendOptions = {
  apiKey: string | undefined;
  /** injectable for tests; defaults to a real MutationClient */
  makeClient?: (apiKey: string) => Pick<MutationClient, "rawPlan" | "rawRepair">;
  /** Phase 1.2: providing an auth store turns on auth + quotas. Omitted =
   * Phase 1.1 open local proxy (first-class dev mode, doc 07 §6 spirit). */
  auth?: { store: AuthStore; sessions: Sessions;
    /** dev mode: return the magic link in the response instead of email —
     * an email provider is a deploy-time concern (OPEN-QUESTIONS) */
    devLinks?: boolean;
    sendEmail?: (email: string, link: string) => Promise<void> };
};

export function makeDevAuth(): NonNullable<BackendOptions["auth"]> {
  return { store: new MemoryAuthStore(), sessions: new Sessions(), devLinks: true };
}

export function createApp(opts: BackendOptions): Hono {
  const app = new Hono();
  app.use("/*", cors({
    origin: (o) => o ?? "*", credentials: true,
    allowMethods: ["POST", "GET", "OPTIONS"],
  }));

  const client = (): Pick<MutationClient, "rawPlan" | "rawRepair"> => {
    if (!opts.apiKey) throw new Error("server is not configured with a model key");
    return (opts.makeClient ?? ((k) =>
      new MutationClient({ mode: "byo", apiKey: k }, { modelRepair: true })))(opts.apiKey);
  };

  app.get("/healthz", (c) => c.json({ ok: true, model: Boolean(opts.apiKey) }));

  // ---------- Phase 1.2: magic-link auth + quotas (doc 07 §1–3) ----------
  const auth = opts.auth;
  const sessionUser = (c: Context): string | null => {
    if (!auth) return null;
    const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    return auth.sessions.userIdFor(bearer ?? getCookie(c, "clay_session"));
  };

  if (auth) {
    app.post("/auth/magic-link", async (c) => {
      const body = await c.req.json().catch(() => null) as { email?: string } | null;
      const email = body?.email?.trim().toLowerCase();
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
        return c.json({ error: "a real email address is required" }, 400);
      const token = auth.sessions.issueLink(auth.store.upsertUser(email));
      if (!token) return c.json({ error: "too many links — try again in an hour" }, 429);
      const link = `/auth/callback?token=${token}`;
      if (auth.devLinks) return c.json({ link });         // dev/tests: no email hop
      await auth.sendEmail?.(email, link);
      return c.body(null, 204);
    });

    app.get("/auth/callback", (c) => {
      const sid = auth.sessions.redeem(c.req.query("token") ?? "");
      if (!sid) return c.json({ error: "link expired — request a fresh one" }, 401);
      setCookie(c, "clay_session", sid,
        { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 30 * 86400 });
      // bearer echo: lets a cross-origin client store the session itself
      return c.json({ ok: true, session: sid });
    });

    app.get("/me", (c) => {
      const userId = sessionUser(c);
      const user = userId ? auth.store.getUser(userId) : null;
      if (!user) return c.json({ error: "sign in first" }, 401);
      const usage = auth.store.usage(user.id);
      return c.json({
        user_id: user.id, plan: user.plan,
        mutations_used: usage.used,
        quota: user.plan === "pro" ? null : FREE_QUOTA,
        period_end: new Date(usage.periodStart + 30 * 86_400_000).toISOString(),
      });
    });
  }

  /** Plan calls are metered; repairs are free (they're Clay's failure, not
   * the user's). Returns a Response to short-circuit, or null to proceed. */
  const guard = (c: Context, metered: boolean): Response | null => {
    if (!auth) return null;                              // Phase 1.1 open mode
    const userId = sessionUser(c);
    const user = userId ? auth.store.getUser(userId) : null;
    if (!user) return c.json({ error: "sign in first" }, 401);
    if (metered && user.plan !== "pro") {
      const usage = auth.store.usage(user.id);
      if (usage.used >= FREE_QUOTA)
        return c.json({
          error: `free plan is ${FREE_QUOTA} reshapes per 30 days — resets `
            + new Date(usage.periodStart + 30 * 86_400_000).toISOString().slice(0, 10),
          mutations_used: usage.used, quota: FREE_QUOTA,
        }, 429);
      auth.store.incrementUsage(user.id);
    }
    return null;
  };

  const readBody = async (c: Context): Promise<unknown> => {
    const len = Number(c.req.header("content-length") ?? "0");
    if (len > BODY_CAP) throw new Response("body too large", { status: 413 });
    return c.req.json();
  };

  app.post("/mutations/plan", async (c) => {
    const denied = guard(c, true);
    if (denied) return denied;
    let body: { context?: S1Context };
    try { body = (await readBody(c)) as typeof body; }
    catch (e) { if (e instanceof Response) return e; return c.json({ error: "bad JSON" }, 400); }
    if (!body?.context) return c.json({ error: "missing context" }, 400);
    try {
      const raw = await client().rawPlan(body.context);
      return c.body(raw, 200, { "content-type": "application/json" });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  app.post("/mutations/repair", async (c) => {
    const denied = guard(c, false);   // repairs never double-charge (doc 07 §3)
    if (denied) return denied;
    let body: { context?: S1Context; prior_plan?: string; failures?: string[] };
    try { body = (await readBody(c)) as typeof body; }
    catch (e) { if (e instanceof Response) return e; return c.json({ error: "bad JSON" }, 400); }
    if (!body?.context || typeof body.prior_plan !== "string")
      return c.json({ error: "missing context or prior_plan" }, 400);
    try {
      const raw = await client().rawRepair(body.context, body.prior_plan, body.failures ?? []);
      return c.body(raw, 200, { "content-type": "application/json" });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  });

  return app;
}
