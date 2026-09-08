// Phase 1.2 (doc 07 §1-3): magic-link auth, sessions, quotas, /me meter.
import { describe, expect, it } from "vitest";
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

  it("rejects garbage emails, expired tokens, and enforces 3 links/hour", async () => {
    const { app } = appWithAuth();
    expect((await app.request("/auth/magic-link", { method: "POST",
      body: JSON.stringify({ email: "nope" }),
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

  it("meters plan calls, refuses at the quota, and repairs stay free", async () => {
    const { app } = appWithAuth();
    const sid = await signIn(app, "q@example.com");
    for (let i = 0; i < FREE_QUOTA; i++) expect((await plan(app, sid)).status).toBe(200);
    const over = await plan(app, sid);
    expect(over.status).toBe(429);
    expect(((await over.json()) as { error: string }).error).toContain("free plan");
    // repairs don't double-charge — still allowed past the quota
    const repair = await app.request("/mutations/repair", { method: "POST",
      body: JSON.stringify({ ...CTX, prior_plan: "{}", failures: ["x"] }),
      headers: { "content-type": "application/json", authorization: `Bearer ${sid}` } });
    expect(repair.status).toBe(200);
    const me = await app.request("/me", { headers: { authorization: `Bearer ${sid}` } });
    expect(((await me.json()) as { mutations_used: number }).mutations_used).toBe(FREE_QUOTA);
  });

  it("atomically admits at most the free quota under concurrent requests", async () => {
    const { app } = appWithAuth();
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
