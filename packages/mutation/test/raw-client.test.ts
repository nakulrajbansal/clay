import { expect, it } from "vitest";
import { ClayStore, createInProcessPlannerMutationAuthority } from "@clay/kernel";
import { decodePlannerRaw, MutationPipeline } from "@clay/kernel/planner-pipeline";
import { MutationClient } from "../src/client";
import { RawMutationClient } from "../src/raw-client";
import type { S1Context } from "../src/prompt";

const context: S1Context = { registry: [], panels: [], recentSummaries: [], intent: "Add a view" };
const base = {
  api: 1, summary: "Add a view.", user_facing_diff: [{ kind: "add_panel", detail: "View" }],
  clarifying_question: null, assumptions: [], migration: null,
  panels: [{ panel_id: "view", title: "View", placement: { region: "main", order: 0 },
    code: "export default function(clay){}", declared_queries: [], declared_writes: [] }],
  remove_panels: [], confidence: .9,
};
const wire = { ...base, migration: JSON.stringify({ operations: [{ op: "add_column", table: "projects",
  column: { name: "priority", type: "enum", required: false, values: ["low", "high"] } }],
  inverse: [{ op: "drop_column_if_added_by_this", table: "projects", column: "priority" }] }),
  panels: [{ ...base.panels[0], declared_queries: [JSON.stringify({ from: "projects" })] }] };
const variants = [
  ["ordinary", base], ["wire JSON", wire],
  ["clipped prose", { ...base, summary: "s".repeat(401), assumptions: Array(7).fill("a".repeat(301)),
    user_facing_diff: [{ kind: "add_panel", detail: "d".repeat(251) }] }],
  ...["Board", "Timeline"].map(name => [name, { ...base,
    panels: [{ ...base.panels[0], code: `export default function(clay){ return ${name}; }` }] }]),
  ["explicit narrow width", { ...base, panels: [{ ...base.panels[0], placement: { region: "main", order: 0, w: 2 },
    code: "export default function(clay){ return Board; }" }] }],
  ["inner malformed JSON", { ...wire, migration: "{" }],
  ["closed field rejection", { ...base, unexpected: true }],
  ["nested issue path", { ...base, panels: [{ ...base.panels[0], placement: { region: "wrong", order: -1 } }] }],
] as const;
for (const [name, input] of variants) it(`raw transport + worker decoding preserves ${name}`, async () => {
  const raw = JSON.stringify(input);
  const fetchFn = async () => new Response(raw);
  const transport = { mode: "hosted" as const, endpoint: "http://127.0.0.1:8788" };
  const parsed = await new MutationClient(transport, { fetchFn }).requestPlan(context);
  const bytes = await new RawMutationClient(transport, { fetchFn }).rawPlan(context);
  expect(bytes).toBe(raw);
  expect(decodePlannerRaw(bytes)).toEqual(parsed);
});
it("keeps malformed top-level and private-looking untrusted bytes opaque until the worker rejects them", async () => {
  for (const raw of ["not json", "null", "[]", '{"panels":[[]]}', '{"__proto__":{"polluted":true}}']) {
    const client = new RawMutationClient({ mode: "hosted", endpoint: "http://127.0.0.1:8788" },
      { fetchFn: async () => new Response(raw) });
    expect(await client.rawPlan(context)).toBe(raw);
    expect(decodePlannerRaw(raw).ok).toBe(false);
  }
  expect({}).not.toHaveProperty("polluted");
});
it("keeps the worker's single repair limit, exact issue paths and prior bytes, with no durable write", async () => {
  const store = await ClayStore.openMemory();
  try {
    const calls: { url: string; body: unknown; capability: string | undefined }[] = [];
    const raw = JSON.stringify({ ...base, panels: [{ ...base.panels[0], panel_id: "BadId" }] });
    const client = new RawMutationClient({ mode: "hosted", endpoint: "http://127.0.0.1:8788" }, {
      fetchFn: async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body), capability: init.headers["x-clay-repair-capability"] });
        return new Response(raw, { headers: { "x-clay-repair-capability": "a".repeat(48) } });
      },
    });
    const pipeline = new MutationPipeline(createInProcessPlannerMutationAuthority(store), {
      requestPlan: async ctx => {
        expect(ctx.registry).toEqual([]); // This fixture's authority owns an empty schema.
        return decodePlannerRaw(await client.rawPlan({ ...ctx, registry: [] }));
      },
      requestRepair: async (ctx, prior, failures) => {
        expect(ctx.registry).toEqual([]);
        return decodePlannerRaw(await client.rawRepair({ ...ctx, registry: [] }, prior, failures));
      },
    });
    const result = await pipeline.run("Add a view");
    expect(result.status).toBe("failed");
    expect(calls.map(c => c.url.split("/").at(-1))).toEqual(["plan", "repair"]);
    expect(calls[1]!.body).toMatchObject({ prior_plan: raw, failures: [expect.stringContaining("panels.0.panel_id")] });
    expect(calls[1]!.capability).toBe("a".repeat(48));
    expect(store.history()).toEqual([]);
  } finally { store.close(); }
});
