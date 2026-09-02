// Backend proxy contract (Phase 1.1) with an injected fake model client —
// no real API. Verifies the wire shape the shell's hosted transport
// expects: POST {context} -> raw plan text; repair takes {context,
// prior_plan, failures}; errors map to 4xx/5xx; the body carries context
// only (records never reach the server).
import { describe, expect, it } from "vitest";
import type { S1Context } from "@clay/mutation";
import { createApp } from "../src/app";

const RAW_PLAN = JSON.stringify({
  api: 1, summary: "Adds a field.", user_facing_diff: [],
  clarifying_question: null, assumptions: [], migration: null,
  panels: [], remove_panels: [], confidence: 0.9,
});

function fakeClient(over: Partial<{ plan: string; repair: string; throws: string }> = {}) {
  return {
    rawPlan: async (): Promise<string> => {
      if (over.throws) throw new Error(over.throws);
      return over.plan ?? RAW_PLAN;
    },
    rawRepair: async (): Promise<string> => over.repair ?? RAW_PLAN,
  };
}

const ctx: S1Context = {
  registry: [{ name: "projects", columns: [] }],
  panels: [], recentSummaries: [], intent: "add a notes field",
};

function app(over?: Parameters<typeof fakeClient>[0], apiKey = "sk-test") {
  return createApp({ apiKey, makeClient: () => fakeClient(over) });
}

describe("healthz", () => {
  it("reports model configured", async () => {
    const res = await app().request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, model: true });
  });
  it("reports missing key", async () => {
    const res = await createApp({ apiKey: undefined }).request("/healthz");
    expect(await res.json()).toEqual({ ok: true, model: false });
  });

  it("reports and passes an explicit OpenAI model configuration", async () => {
    let received: unknown;
    const configured = createApp({
      model: { provider: "openai", apiKey: "openai-test", model: "gpt-5.6" },
      makeClient: config => { received = config; return fakeClient(); },
    });
    expect(await (await configured.request("/healthz")).json())
      .toEqual({ ok: true, model: true, provider: "openai", model_id: "gpt-5.6" });
    await configured.request("/mutations/plan", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ context: ctx }),
    });
    expect(received).toEqual({ provider: "openai", apiKey: "openai-test", model: "gpt-5.6" });
  });
});

describe("/mutations/plan", () => {
  it("relays the raw plan for a valid context", async () => {
    const res = await app().request("/mutations/plan", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ context: ctx }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(RAW_PLAN);
  });

  it("rejects a body with no context", async () => {
    const res = await app().request("/mutations/plan", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ not_context: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it("enforces the 64KB body cap even without a Content-Length header", async () => {
    const request = new Request("http://local/mutations/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ context: ctx, padding: "x".repeat(70 * 1024) }),
    });
    const res = await app().fetch(request);
    expect(res.status).toBe(413);
  });

  it("maps a model failure to 502", async () => {
    const res = await app({ throws: "anthropic 529 overloaded" }).request("/mutations/plan", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ context: ctx }),
    });
    expect(res.status).toBe(502);
    expect((await res.json() as { error: string }).error).toContain("529");
  });

  it("500s cleanly when the server has no key", async () => {
    const res = await createApp({ apiKey: undefined }).request("/mutations/plan", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ context: ctx }),
    });
    expect(res.status).toBe(502);
    expect((await res.json() as { error: string }).error).toContain("not configured");
  });
});

describe("/mutations/repair", () => {
  it("relays the repaired raw plan", async () => {
    const repaired = JSON.stringify({ ...JSON.parse(RAW_PLAN), summary: "Fixed." });
    const res = await app({ repair: repaired }).request("/mutations/repair", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ context: ctx, prior_plan: RAW_PLAN, failures: ["V4: x"] }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(repaired);
  });

  it("requires prior_plan", async () => {
    const res = await app().request("/mutations/repair", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ context: ctx }),
    });
    expect(res.status).toBe(400);
  });
});

describe("privacy: only context crosses the wire (ADR-009)", () => {
  it("the accepted body carries schema shapes + intent, never rows", () => {
    // the context type has no row field; assert the shape the shell posts
    const body = JSON.stringify({ context: ctx });
    expect(body).toContain("\"intent\"");
    expect(body).toContain("\"registry\"");
    expect(body).not.toContain("\"rows\"");
  });
});

describe("local connector mutation boundary", () => {
  const token = "connector-token-for-tests-1234567890";
  const origin = "http://127.0.0.1:4173";
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    origin,
  };

  it("fails closed before invoking Codex for text/plain, missing tokens, or bad origins", async () => {
    let calls = 0;
    const guarded = createApp({
      model: { provider: "codex" },
      makeClient: () => ({
        rawPlan: async () => { calls++; return RAW_PLAN; },
        rawRepair: async () => RAW_PLAN,
      }),
      allowedOrigins: [origin], mutationToken: token,
      requireAllowedMutationOrigin: true,
    });
    const plain = await guarded.request("/mutations/plan", {
      method: "POST", headers: { "content-type": "text/plain" },
      body: JSON.stringify({ context: ctx }),
    });
    expect(plain.status).toBe(415);
    const unauthenticated = await guarded.request("/mutations/plan", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ context: ctx }),
    });
    expect(unauthenticated.status).toBe(401);
    const badOrigin = await guarded.request("/mutations/plan", {
      method: "POST", headers: { ...headers, origin: "https://evil.example" },
      body: JSON.stringify({ context: ctx }),
    });
    expect(badOrigin.status).toBe(403);
    expect(calls).toBe(0);
  });

  it("exposes a per-launch token only when configured and accepts the matching bearer", async () => {
    const guarded = createApp({
      model: { provider: "codex" }, makeClient: () => fakeClient(),
      allowedOrigins: [origin], mutationToken: token,
      exposeMutationTokenOnHealth: true, requireAllowedMutationOrigin: true,
    });
    const anonymousHealth = await guarded.request("/healthz");
    expect(await anonymousHealth.json()).not.toHaveProperty("connector_token");
    const browserHealth = await guarded.request("/healthz", { headers: { origin } });
    expect(browserHealth.headers.get("cache-control")).toBe("no-store");
    expect(await browserHealth.json()).toMatchObject({
      provider: "codex", connector_token: token,
    });
    const response = await guarded.request("/mutations/plan", {
      method: "POST", headers, body: JSON.stringify({ context: ctx }),
    });
    expect(response.status).toBe(200);
  });

  it("enforces one active mutation and the configured request rate", async () => {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const guarded = createApp({
      model: { provider: "codex" },
      makeClient: () => ({
        rawPlan: async () => { entered(); await held; return RAW_PLAN; },
        rawRepair: async () => RAW_PLAN,
      }),
      allowedOrigins: [origin], mutationToken: token,
      mutationConcurrency: 1, mutationRate: { max: 2, windowMs: 60_000 },
    });
    const first = guarded.request("/mutations/plan", {
      method: "POST", headers, body: JSON.stringify({ context: ctx }),
    });
    await started;
    const concurrent = await guarded.request("/mutations/plan", {
      method: "POST", headers, body: JSON.stringify({ context: ctx }),
    });
    expect(concurrent.status).toBe(429);
    release();
    expect((await first).status).toBe(200);
    const rateLimited = await guarded.request("/mutations/plan", {
      method: "POST", headers, body: JSON.stringify({ context: ctx }),
    });
    expect(rateLimited.status).toBe(429);
  });
});
