// Phase 1.2 (doc 07 §1-3): magic-link auth, sessions, quotas, /me meter.
import { describe, expect, it, vi } from "vitest";
import { createApp, makeDevAuth } from "../src/app";
import { FREE_QUOTA } from "../src/auth";

const fakeClient = { rawPlan: async () => "{}", rawRepair: async () => "{}" };
const CTX = { context: { intent: "x", registry: [], panels: [] } };
const AUTH_STATE = "a".repeat(64);
const authBody = (email: string): string => JSON.stringify({ email, state: AUTH_STATE });

function appWithAuth() {
  const auth = makeDevAuth();
  const app = createApp({ apiKey: "k", makeClient: () => fakeClient, auth });
  return { app, auth };
}

async function signIn(app: ReturnType<typeof createApp>, email: string): Promise<string> {
  const linkRes = await app.request("/auth/magic-link", {
    method: "POST", body: authBody(email),
    headers: { "content-type": "application/json" } });
  const { link } = await linkRes.json() as { link: string };
  const cb = await app.request(link);
  const { session } = await cb.json() as { session: string };
  return session;
}

describe("magic-link auth (Phase 1.2)", () => {
  it("link -> callback -> session cookie + bearer; /me shows the meter", async () => {
    const { app } = appWithAuth();
    const sid = await signIn(app, "user@example.com");
    const me = await app.request("/me", { headers: { authorization: `Bearer ${sid}` } });
    expect(me.status).toBe(200);
    const body = await me.json() as Record<string, unknown>;
    expect(body.plan).toBe("free");
    expect(body.mutations_used).toBe(0);
    expect(body.quota).toBe(FREE_QUOTA);
  });

  it("rejects non-JSON and cross-site issuance before durable or email side effects", async () => {
    const auth = makeDevAuth();
    const upsert = vi.spyOn(auth.store, "upsertUser");
    const issue = vi.spyOn(auth.sessions, "issueLink");
    const sendEmail = vi.fn(async () => undefined);
    const protectedApp = createApp({
      apiKey: "sk-test", makeClient: () => fakeClient,
      allowedOrigins: ["https://clay.example"],
      auth: { store: auth.store, sessions: auth.sessions, sendEmail },
    });
    const plain = await protectedApp.request("/auth/magic-link", {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://clay.example" },
      body: authBody("plain@example.com"),
    });
    const crossSite = await protectedApp.request("/auth/magic-link", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
      body: authBody("cross-site@example.com"),
    });
    const missingOrigin = await protectedApp.request("/auth/magic-link", {
      method: "POST", headers: { "content-type": "application/json" },
      body: authBody("missing-origin@example.com"),
    });
    expect(plain.status).toBe(415);
    expect(crossSite.status).toBe(403);
    expect(missingOrigin.status).toBe(403);
    expect(issue).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("creates no durable user until the emailed token proves ownership", async () => {
    const { app, auth } = appWithAuth();
    const upsert = vi.spyOn(auth.store, "upsertUser");
    const linkResponse = await app.request("/auth/magic-link", {
      method: "POST", headers: { "content-type": "application/json" },
      body: authBody("proof@example.com"),
    });
    const { link } = await linkResponse.json() as { link: string };
    expect(linkResponse.status).toBe(200);
    expect(upsert).not.toHaveBeenCalled();
    expect((await app.request(link)).status).toBe(200);
    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert).toHaveBeenCalledWith("proof@example.com");
  });

  it("deletes an undelivered token instead of leaving durable redemption authority", async () => {
    const auth = makeDevAuth();
    let undeliveredLink = "";
    const protectedApp = createApp({
      apiKey: "sk-test", makeClient: () => fakeClient,
      auth: {
        store: auth.store,
        sessions: auth.sessions,
        sendEmail: async (_email, link) => {
          undeliveredLink = link;
          throw new Error("mail provider unavailable");
        },
      },
    });
    const response = await protectedApp.request("/auth/magic-link", {
      method: "POST", headers: { "content-type": "application/json" },
      body: authBody("undelivered@example.com"),
    });
    expect(response.status).toBe(502);
    expect(undeliveredLink).toContain("/auth/callback?");
    expect((await protectedApp.request(undeliveredLink)).status).toBe(401);
  });

  it("shares per-source and global issuance admission across backend instances", async () => {
    const auth = makeDevAuth();
    const options = {
      apiKey: "sk-test", makeClient: () => fakeClient, auth,
      magicLinkRate: { windowMs: 60_000, maxPerEmail: 3, maxPerSource: 2, maxGlobal: 3 },
    } as const;
    const first = createApp(options);
    const second = createApp(options);
    const issue = (app: ReturnType<typeof createApp>, email: string, source: string) =>
      app.request("/auth/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": source },
        body: authBody(email),
      });
    expect((await issue(first, "one@example.com", "192.0.2.1")).status).toBe(200);
    expect((await issue(second, "two@example.com", "192.0.2.1")).status).toBe(200);
    expect((await issue(first, "three@example.com", "192.0.2.1")).status).toBe(429);
    expect((await issue(second, "three@example.com", "192.0.2.2")).status).toBe(200);
    expect((await issue(first, "four@example.com", "192.0.2.3")).status).toBe(429);
  });

  it("rejects garbage emails, expired tokens, and enforces 3 links/hour", async () => {
    const { app } = appWithAuth();
    expect((await app.request("/auth/magic-link", { method: "POST",
      body: JSON.stringify({ email: "nope" }),
      headers: { "content-type": "application/json" } })).status).toBe(400);
    expect((await app.request("/auth/magic-link", { method: "POST",
      body: authBody(`${"a".repeat(1_000)}@example.com`),
      headers: { "content-type": "application/json" } })).status).toBe(400);
    expect((await app.request("/auth/magic-link", { method: "POST",
      body: JSON.stringify({ email: "valid@example.com", state: "short" }),
      headers: { "content-type": "application/json" } })).status).toBe(400);
    const invalidNav = await app.request("/auth/callback?token=bogus&state=short",
      { headers: { accept: "text/html" } });
    expect(invalidNav.headers.get("location")).toBe("/#auth=invalid");
    expect(invalidNav.headers.get("set-cookie")).toBeNull();
    expect((await app.request(`/auth/callback?token=bogus&state=${AUTH_STATE}`)).status).toBe(401);
    for (let i = 0; i < 3; i++) await signIn(app, "hot@example.com");
    const fourth = await app.request("/auth/magic-link", { method: "POST",
      body: authBody("hot@example.com"),
      headers: { "content-type": "application/json" } });
    expect(fourth.status).toBe(429);
  });

  it("hands an email click back to the app without redeeming or setting a cookie", async () => {
    const { app } = appWithAuth();
    const state = AUTH_STATE;
    const linkRes = await app.request("/auth/magic-link", { method: "POST",
      body: JSON.stringify({ email: "click@example.com", state }),
      headers: { "content-type": "application/json" } });
    const { link } = await linkRes.json() as { link: string };
    expect(new URL(link, "https://clay.example").searchParams.get("state")).toBe(state);
    const nav = await app.request(link, { headers: { accept: "text/html,application/xhtml+xml" } });
    expect(nav.status).toBe(302);
    const location = nav.headers.get("location")!;
    expect(location).toContain("/#auth=complete&");
    expect(location).toContain(`&state=${state}`);
    expect(nav.headers.get("set-cookie")).toBeNull();

    const fragment = new URL(location, "https://clay.example").hash.slice(1);
    const handoff = new URLSearchParams(fragment);
    expect(handoff.get("token")).toMatch(/^[a-f0-9]{48}$/);
    const redeemed = await app.request(
      `/auth/callback?token=${handoff.get("token")}&state=${handoff.get("state")}`,
      { headers: { accept: "application/json" } },
    );
    expect(redeemed.status).toBe(200);
    expect((await redeemed.json() as { session?: string }).session).toBeTruthy();
  });

  it("marks session cookies Secure on HTTPS and logout revokes bearer and cookie", async () => {
    const { app } = appWithAuth();
    const linkRes = await app.request("/auth/magic-link", { method: "POST",
      body: authBody("secure@example.com"),
      headers: { "content-type": "application/json" } });
    const { link } = await linkRes.json() as { link: string };
    const callback = await app.request(`https://clay.example${link}`);
    const { session } = await callback.json() as { session: string };
    expect(callback.headers.get("set-cookie")).toContain("Secure");

    const rolled = await app.request("https://clay.example/me", {
      headers: { cookie: `clay_session=${session}` },
    });
    expect(rolled.status).toBe(200);
    expect(rolled.headers.get("set-cookie")).toMatch(/Max-Age=2592000/i);

    const logout = await app.request("https://clay.example/auth/logout", {
      method: "POST", headers: { authorization: `Bearer ${session}` },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toMatch(/clay_session=;.*Max-Age=0/i);
    expect((await app.request("/me", {
      headers: { authorization: `Bearer ${session}` },
    })).status).toBe(401);
  });

  it("revokes distinct bearer and cookie sessions presented together", async () => {
    const { app } = appWithAuth();
    const cookieSession = await signIn(app, "dual-session@example.com");
    const bearerSession = await signIn(app, "dual-session@example.com");
    expect(cookieSession).not.toBe(bearerSession);

    const logout = await app.request("https://clay.example/auth/logout", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearerSession}`,
        cookie: `clay_session=${cookieSession}`,
      },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toMatch(/clay_session=;.*Max-Age=0/i);
    for (const session of [bearerSession, cookieSession]) {
      expect((await app.request("/me", {
        headers: { authorization: `Bearer ${session}` },
      })).status).toBe(401);
    }
  });

  it("refuses an auth configuration that cannot deliver links", () => {
    const dev = makeDevAuth();
    expect(() => createApp({ apiKey: "sk-test", auth: {
      store: dev.store, sessions: dev.sessions,
    } })).toThrow(/magic-link delivery/i);
  });

  it("magic-link tokens are single-use", async () => {
    const { app } = appWithAuth();
    const linkRes = await app.request("/auth/magic-link", { method: "POST",
      body: authBody("once@example.com"),
      headers: { "content-type": "application/json" } });
    const { link } = await linkRes.json() as { link: string };
    expect((await app.request(link)).status).toBe(200);
    expect((await app.request(link)).status).toBe(401);
  });
});

describe("quotas (Phase 1.2)", () => {
  const plan = (app: ReturnType<typeof createApp>, sid: string) =>
    app.request("/mutations/plan", { method: "POST",
      body: JSON.stringify(CTX),
      headers: { "content-type": "application/json", authorization: `Bearer ${sid}` } });

  it("unauthenticated plan calls are refused when auth is on", async () => {
    const { app } = appWithAuth();
    const res = await app.request("/mutations/plan", { method: "POST",
      body: JSON.stringify(CTX), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(401);
  });

  it("binds exactly one repair to the metered session, context, and returned plan", async () => {
    let repairs = 0;
    const auth = makeDevAuth();
    const bound = createApp({
      apiKey: "sk-test",
      auth,
      makeClient: () => ({
        rawPlan: async () => "{\"plan\":\"bound\"}",
        rawRepair: async () => { repairs++; return "{\"plan\":\"repaired\"}"; },
      }),
    });
    const owner = await signIn(bound, "repair-owner@example.com");
    const other = await signIn(bound, "repair-other@example.com");
    const planResponse = await plan(bound, owner);
    const priorPlan = await planResponse.text();
    const capability = planResponse.headers.get("x-clay-repair-capability");
    expect(planResponse.status).toBe(200);
    expect(capability).toMatch(/^[a-f0-9]{48}$/);

    const repair = (session: string, context: unknown, prior: string, token = capability) =>
      bound.request("/mutations/repair", {
        method: "POST",
        body: JSON.stringify({ context, prior_plan: prior, failures: ["V4: hostile"] }),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session}`,
          ...(token ? { "x-clay-repair-capability": token } : {}),
        },
      });
    const exactContext = CTX.context;
    expect((await repair(owner, exactContext, priorPlan, null)).status).toBe(403);
    expect((await repair(other, exactContext, priorPlan)).status).toBe(403);
    expect((await repair(owner, { ...exactContext, intent: "different" }, priorPlan)).status).toBe(403);
    expect((await repair(owner, exactContext, priorPlan + " ")).status).toBe(403);
    expect(repairs).toBe(0);

    expect((await repair(owner, exactContext, priorPlan)).status).toBe(200);
    expect((await repair(owner, exactContext, priorPlan)).status).toBe(403);
    expect(repairs).toBe(1);
    const me = await bound.request("/me", {
      headers: { authorization: `Bearer ${owner}` },
    });
    expect((await me.json() as { mutations_used: number }).mutations_used).toBe(1);
  });

  it("shares rate and concurrency admission across fresh backend instances", async () => {
    const auth = makeDevAuth();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const options = {
      apiKey: "sk-test",
      auth,
      mutationRate: { max: 2, windowMs: 60_000 },
      mutationConcurrency: 1,
    } as const;
    const firstInstance = createApp({
      ...options,
      makeClient: () => ({
        rawPlan: async () => { entered(); await held; return "{}"; },
        rawRepair: async () => "{}",
      }),
    });
    const secondInstance = createApp({
      ...options,
      makeClient: () => fakeClient,
    });
    const sid = await signIn(firstInstance, "admission@example.com");
    const first = plan(firstInstance, sid);
    await started;
    const concurrent = await plan(secondInstance, sid);
    expect(concurrent.status).toBe(429);
    release();
    expect((await first).status).toBe(200);
    expect((await plan(secondInstance, sid)).status).toBe(200);
    expect((await plan(firstInstance, sid)).status).toBe(429);
  });

  it("meters plan calls, refuses at the quota, and repairs stay free", async () => {
    const { app } = appWithAuth();
    const sid = await signIn(app, "q@example.com");
    let repairCapability: string | null = null;
    for (let i = 0; i < FREE_QUOTA; i++) {
      const response = await plan(app, sid);
      expect(response.status).toBe(200);
      repairCapability = response.headers.get("x-clay-repair-capability");
    }
    const over = await plan(app, sid);
    expect(over.status).toBe(429);
    expect(((await over.json()) as { error: string }).error).toContain("free plan");
    // repairs don't double-charge — still allowed past the quota
    const repair = await app.request("/mutations/repair", { method: "POST",
      body: JSON.stringify({ ...CTX, prior_plan: "{}", failures: ["x"] }),
      headers: { "content-type": "application/json", authorization: `Bearer ${sid}`,
        "x-clay-repair-capability": repairCapability! } });
    expect(repair.status).toBe(200);
    const me = await app.request("/me", { headers: { authorization: `Bearer ${sid}` } });
    expect(((await me.json()) as { mutations_used: number }).mutations_used).toBe(FREE_QUOTA);
  });

  it("atomically admits at most the free quota under concurrent requests", async () => {
    const auth = makeDevAuth();
    const app = createApp({
      apiKey: "sk-test", makeClient: () => fakeClient, auth,
      mutationConcurrency: FREE_QUOTA + 8,
    });
    const sid = await signIn(app, "race@example.com");
    const results = await Promise.all(Array.from({ length: FREE_QUOTA + 8 }, () => plan(app, sid)));
    expect(results.filter(response => response.status === 200)).toHaveLength(FREE_QUOTA);
    expect(results.filter(response => response.status === 429)).toHaveLength(8);
  });

  it("without an auth store the proxy stays open (Phase 1.1 local mode)", async () => {
    const app = createApp({ apiKey: "k", makeClient: () => fakeClient });
    const res = await app.request("/mutations/plan", { method: "POST",
      body: JSON.stringify(CTX), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(200);
  });
});
