// Phase 1.2 (doc 07 §1-3): magic-link auth, sessions, quotas, /me meter.
import { describe, expect, it } from "vitest";
import { createApp, makeDevAuth } from "../src/app";
import { FREE_QUOTA } from "../src/auth";

const fakeClient = { rawPlan: async () => "{}", rawRepair: async () => "{}" };
const CTX = { context: { intent: "x", registry: [], panels: [] } };

function appWithAuth() {
  const auth = makeDevAuth();
  const app = createApp({ apiKey: "k", makeClient: () => fakeClient, auth });
  return { app, auth };
}

async function signIn(app: ReturnType<typeof createApp>, email: string): Promise<string> {
  const linkRes = await app.request("/auth/magic-link", {
    method: "POST", body: JSON.stringify({ email }),
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
    expect((await app.request("/auth/callback?token=bogus")).status).toBe(401);
    for (let i = 0; i < 3; i++) await signIn(app, "hot@example.com");
    const fourth = await app.request("/auth/magic-link", { method: "POST",
      body: JSON.stringify({ email: "hot@example.com" }),
      headers: { "content-type": "application/json" } });
    expect(fourth.status).toBe(429);
  });

  it("magic-link tokens are single-use", async () => {
    const { app } = appWithAuth();
    const linkRes = await app.request("/auth/magic-link", { method: "POST",
      body: JSON.stringify({ email: "once@example.com" }),
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

  it("without an auth store the proxy stays open (Phase 1.1 local mode)", async () => {
    const app = createApp({ apiKey: "k", makeClient: () => fakeClient });
    const res = await app.request("/mutations/plan", { method: "POST",
      body: JSON.stringify(CTX), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(200);
  });
});
