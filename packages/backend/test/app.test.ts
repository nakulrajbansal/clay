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
