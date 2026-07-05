// MutationClient wire-format tests with a captured fetch: BYO request shape
// (G1 structured outputs, G3 browser header), response handling, repair
// escalation (G2), and the hosted path (doc 07).
import { describe, expect, it } from "vitest";
import apiSchema from "@clay/schema/mutation-plan-api.json";
import {
  DEFAULT_MODEL, MutationClient, REPAIR_MODEL, type S1Context,
} from "../src/index";

const VALID_PLAN = JSON.stringify({
  api: 1, summary: "Adds a list panel.",
  user_facing_diff: [{ kind: "add_panel", detail: "List" }],
  clarifying_question: null, assumptions: [], migration: null,
  panels: [{
    panel_id: "list_panel", title: "List",
    placement: { region: "main", order: 0 },
    code: "export default function(clay){}",
    declared_queries: [], declared_writes: [],
  }],
  remove_panels: [], confidence: 0.9,
});

function anthropicBody(text: string): string {
  return JSON.stringify({
    content: [{ type: "text", text }],
    usage: { input_tokens: 5000, output_tokens: 900 },
    stop_reason: "end_turn",
  });
}

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function fakeFetch(status: number, responseText: string): {
  fetchFn: (url: string, init: { method: string; headers: Record<string, string>; body: string }) =>
    Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  return {
    calls,
    fetchFn: async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
      return { ok: status < 400, status, text: async () => responseText };
    },
  };
}

function ctx(): S1Context {
  return {
    registry: [{ name: "projects", columns: [] }],
    panels: [], recentSummaries: [], intent: "add a notes field",
  };
}

describe("BYO request shape", () => {
  it("hits the Messages API with the G3 header and G1 structured output", async () => {
    const { fetchFn, calls } = fakeFetch(200, anthropicBody(VALID_PLAN));
    const client = new MutationClient({ mode: "byo", apiKey: "sk-test" }, { fetchFn });
    const result = await client.requestPlan(ctx());

    expect(result.ok).toBe(true);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.headers["x-api-key"]).toBe("sk-test");
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(call.body.model).toBe(DEFAULT_MODEL);
    expect(call.body.max_tokens).toBe(6000);
    expect(call.body.temperature).toBe(0.2);
    // simplified schema (G1/ADR-013), sent without annotation keywords the
    // API's grammar rejects ($comment)
    const sent = (call.body.output_config as {
      format: { type: string; schema: Record<string, unknown> };
    }).format;
    expect(sent.type).toBe("json_schema");
    // no annotation keyword the API grammar rejects, anywhere in the tree
    expect(JSON.stringify(sent.schema)).not.toContain("$comment");
    expect(sent.schema.properties).toEqual(
      (apiSchema as { properties: unknown }).properties);
    const messages = call.body.messages as { role: string; content: string }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toContain("<intent>add a notes field</intent>");
    expect((call.body.system as string)).toContain("You write MutationPlans for Clay");
  });

  it("returns the Zod-parsed plan with usage", async () => {
    const { fetchFn } = fakeFetch(200, anthropicBody(VALID_PLAN));
    const client = new MutationClient({ mode: "byo", apiKey: "k" }, { fetchFn });
    const result = await client.requestPlan(ctx());
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan.summary).toBe("Adds a list panel.");
    expect(result.plan.panels[0]!.declared_writes).toEqual([]);   // default applied
    expect(result.usage).toEqual({ input_tokens: 5000, output_tokens: 900 });
  });

  it("hydrates the wire form: migration + declared_queries as JSON strings", async () => {
    // exactly what the API grammar forces the model to emit
    const wire = JSON.stringify({
      api: 1, summary: "Adds a priority field.",
      user_facing_diff: [{ kind: "add_status", detail: "Priority" }],
      clarifying_question: null, assumptions: [],
      migration: JSON.stringify({
        operations: [{ op: "add_column", table: "projects",
          column: { name: "priority", type: "enum", required: false,
            values: ["low", "medium", "high"] } }],
        inverse: [{ op: "drop_column_if_added_by_this", table: "projects", column: "priority" }],
      }),
      panels: [{
        panel_id: "project_table", title: "Projects",
        placement: { region: "main", order: 0 },
        code: "export default function(clay){}",
        declared_queries: [JSON.stringify({ from: "projects" })],
        declared_writes: [],
      }],
      remove_panels: [], confidence: 0.9,
    });
    const { fetchFn } = fakeFetch(200, anthropicBody(wire));
    const client = new MutationClient({ mode: "byo", apiKey: "k" }, { fetchFn });
    const result = await client.requestPlan(ctx());
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    // migration parsed back into an object; the enum column survived
    expect(result.plan.migration?.operations[0]).toMatchObject({ op: "add_column" });
    // declared_queries parsed back into a Query object
    expect(result.plan.panels[0]!.declared_queries[0]).toEqual({ from: "projects" });
  });

  it("malformed inner JSON -> E_PARSE", async () => {
    const wire = JSON.stringify({
      api: 1, summary: "x", user_facing_diff: [], clarifying_question: null,
      assumptions: [], migration: "{not valid json", panels: [],
      remove_panels: [], confidence: 0.9,
    });
    const { fetchFn } = fakeFetch(200, anthropicBody(wire));
    const client = new MutationClient({ mode: "byo", apiKey: "k" }, { fetchFn });
    expect(await client.requestPlan(ctx())).toMatchObject({
      ok: false, error: { code: "E_PARSE" } });
  });
});

describe("failure handling", () => {
  it("non-JSON output -> E_PARSE", async () => {
    const { fetchFn } = fakeFetch(200, anthropicBody("sorry, no"));
    const client = new MutationClient({ mode: "byo", apiKey: "k" }, { fetchFn });
    const r = await client.requestPlan(ctx());
    expect(r).toMatchObject({ ok: false, error: { code: "E_PARSE" } });
  });

  it("schema-invalid plan -> E_SCHEMA with issues (G1 client-side gate)", async () => {
    const { fetchFn } = fakeFetch(200, anthropicBody(`{"api": 2}`));
    const client = new MutationClient({ mode: "byo", apiKey: "k" }, { fetchFn });
    const r = await client.requestPlan(ctx());
    expect(r).toMatchObject({ ok: false, error: { code: "E_SCHEMA" } });
    if (!r.ok) expect(r.error.issues).toBeDefined();
  });

  it("HTTP error -> E_MODEL; thrown fetch -> E_NET", async () => {
    const { fetchFn } = fakeFetch(429, `{"type":"error"}`);
    const client = new MutationClient({ mode: "byo", apiKey: "k" }, { fetchFn });
    expect(await client.requestPlan(ctx())).toMatchObject({
      ok: false, error: { code: "E_MODEL" } });

    const boom = new MutationClient({ mode: "byo", apiKey: "k" }, {
      fetchFn: async () => { throw new Error("offline"); },
    });
    expect(await boom.requestPlan(ctx())).toMatchObject({
      ok: false, error: { code: "E_NET" } });
  });
});

describe("repair round", () => {
  it("appends the prior plan + repair turn; escalates model behind MODEL_REPAIR (G2)", async () => {
    const { fetchFn, calls } = fakeFetch(200, anthropicBody(VALID_PLAN));
    const client = new MutationClient({ mode: "byo", apiKey: "k" },
      { fetchFn, modelRepair: true });
    await client.requestRepair(ctx(), `{"api":1,"broken":true}`, ["V4: undeclared query"]);
    const call = calls[0]!;
    expect(call.body.model).toBe(REPAIR_MODEL);
    const messages = call.body.messages as { role: string; content: string }[];
    expect(messages.map(m => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[1]!.content).toBe(`{"api":1,"broken":true}`);
    expect(messages[2]!.content).toContain("V4: undeclared query");
    expect(messages[2]!.content).toContain("Return a corrected COMPLETE MutationPlan.");
  });

  it("stays on the default model without the flag", async () => {
    const { fetchFn, calls } = fakeFetch(200, anthropicBody(VALID_PLAN));
    const client = new MutationClient({ mode: "byo", apiKey: "k" }, { fetchFn });
    await client.requestRepair(ctx(), `{}`, ["V1: parse error"]);
    expect(calls[0]!.body.model).toBe(DEFAULT_MODEL);
  });
});

describe("hosted mode (doc 07)", () => {
  it("posts the S1 context to /mutations/plan — never an assembled prompt", async () => {
    const { fetchFn, calls } = fakeFetch(200, VALID_PLAN);
    const client = new MutationClient(
      { mode: "hosted", endpoint: "https://clay.example" }, { fetchFn });
    const r = await client.requestPlan(ctx());
    expect(r.ok).toBe(true);
    const call = calls[0]!;
    expect(call.url).toBe("https://clay.example/mutations/plan");
    expect(call.body).toEqual({ context: ctx() });
    expect(call.headers["x-api-key"]).toBeUndefined();   // key never sent to Clay (P3)
  });

  it("repairs post to /mutations/repair with the failure payload", async () => {
    const { fetchFn, calls } = fakeFetch(200, VALID_PLAN);
    const client = new MutationClient(
      { mode: "hosted", endpoint: "https://clay.example" }, { fetchFn });
    await client.requestRepair(ctx(), `{}`, ["V5: bad inverse"]);
    expect(calls[0]!.url).toBe("https://clay.example/mutations/repair");
    expect(calls[0]!.body).toMatchObject({ failures: ["V5: bad inverse"] });
  });
});
