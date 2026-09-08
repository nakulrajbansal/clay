import { describe, expect, it } from "vitest";
import {
  ClayStore,
  MutationPipeline,
  deriveInverse,
  type ForwardOpT,
  type Planner,
  type PlannerResult,
} from "../src/index";
import {
  createInProcessPlannerMutationAuthority,
  createStoreBackedPlannerMutationAuthority,
} from "../src/planner-authority";
import { capturePreparedMutationCommand } from "../src/planner-command";

const utf8Bytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

function relationshipEntry(index: number): { key: string; id: string } {
  const prefix = `${index.toString().padStart(4, "0")}:`;
  return {
    key: `${prefix}${"x".repeat(256 - prefix.length)}`,
    id: `rel_018f0000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`,
  };
}

function preparedCommandAtBytes(targetBytes: number): Record<string, unknown> {
  const command = {
    schema: 1,
    attemptId: "018f0000-0000-7000-8000-000000000001",
    base: { version: 0, shapeSha256: `sha256:${"0".repeat(64)}` },
    intent: "i",
    plan: {
      api: 1,
      summary: "Budget boundary.",
      user_facing_diff: [],
      clarifying_question: null,
      assumptions: [],
      migration: null,
      panels: [],
      remove_panels: ["old_panel"],
      confidence: 1,
    },
    semanticAssignments: {
      schema: 1,
      version: 1,
      origin: "model",
      tables: [],
      fields: [],
      relationships: [] as Array<{ key: string; id: string }>,
    },
  };
  const sampleBytes = utf8Bytes(relationshipEntry(0));
  const emptyBytes = utf8Bytes(command);
  const count = Math.floor((targetBytes - emptyBytes + 1) / (sampleBytes + 1));
  for (let index = 0; index < count; index++)
    command.semanticAssignments.relationships.push(relationshipEntry(index));
  const remaining = targetBytes - utf8Bytes(command);
  if (remaining < 0 || remaining > 499)
    throw new Error(`unable to construct exact planner command budget: ${remaining}`);
  command.intent += "x".repeat(remaining);
  if (utf8Bytes(command) !== targetBytes)
    throw new Error("planner command budget fixture is not exact");
  return command;
}

async function previewFixture(): Promise<{
  store: ClayStore;
  plan: Record<string, unknown>;
}> {
  const store = await ClayStore.openMemory();
  const seed: ForwardOpT[] = [{
    op: "create_table",
    table: "projects",
    columns: [{ name: "name", type: "text", required: true }],
  }];
  store.commit({
    intent: "seed",
    summary: "Creates projects.",
    migration: { operations: seed, inverse: deriveInverse(seed, store.registrySnapshot()) },
  });
  const operations: ForwardOpT[] = [{
    op: "add_column",
    table: "projects",
    column: { name: "status", type: "text", required: false },
  }];
  return {
    store,
    plan: {
      api: 1,
      summary: "Adds project status.",
      user_facing_diff: [{ kind: "add_field", detail: "Add status to projects" }],
      clarifying_question: null,
      assumptions: [],
      migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
      panels: [],
      remove_panels: [],
      confidence: 1,
    },
  };
}

describe("planner request capture budget", () => {
  it("accepts exactly 2,000,000 UTF-8 JSON bytes and rejects the next byte", () => {
    const exact = preparedCommandAtBytes(2_000_000);
    const captured = capturePreparedMutationCommand(exact);
    expect(captured.semanticAssignments.relationships)
      .toHaveLength((exact.semanticAssignments as { relationships: unknown[] }).relationships.length);

    expect(() => capturePreparedMutationCommand({
      ...exact,
      intent: `${String(exact.intent)}x`,
    })).toThrowError(expect.objectContaining({ code: "E_LIMIT" }));
  });

  it("charges multibyte text plus complete JSON framing as UTF-8", () => {
    expect(() => capturePreparedMutationCommand({
      plan: "💩".repeat(500_000),
    })).toThrowError(expect.objectContaining({ code: "E_LIMIT" }));
  });
});

describe("planner preview capture boundary", () => {
  it("rejects accessors, transparent proxies, sparse arrays, and exotic arrays before schema validation", async () => {
    const { store, plan } = await previewFixture();
    const authority = createInProcessPlannerMutationAuthority(store);
    let getterCalls = 0;
    const accessorPlan = { ...plan };
    Object.defineProperty(accessorPlan, "migration", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return plan.migration;
      },
    });
    class ExoticArray<T> extends Array<T> {}
    const cases: Array<[string, unknown]> = [
      ["accessor", accessorPlan],
      ["proxy", new Proxy({ ...plan }, {})],
      ["sparse array", { ...plan, panels: new Array(1) }],
      ["exotic array", { ...plan, panels: new ExoticArray() }],
    ];
    try {
      for (const [label, hostilePlan] of cases) {
        let preview: Awaited<ReturnType<typeof authority.preparePreview>> | undefined;
        let failure: unknown;
        try {
          preview = await authority.preparePreview({
            attemptId: "018f0000-0000-7000-8000-000000000001",
            base: authority.capturePlanningBase().base,
            intent: "add status to projects",
            plan: hostilePlan as never,
          });
        } catch (error) {
          failure = error;
        } finally {
          preview?.shadow.close();
        }
        expect(failure, label).toMatchObject({ code: "E_TARGET_AUTHORITY_INVALID" });
      }
      expect(getterCalls).toBe(0);
    } finally {
      store.close();
    }
  });

  it("leaves Keep and Discard capture at the configured mutation coordinator boundary", async () => {
    const { store } = await previewFixture();
    const delivered: Array<{ decision: "keep" | "discard"; command: unknown }> = [];
    let getterCalls = 0;
    const command = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(command, "plan", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return {};
      },
    });
    const authority = createStoreBackedPlannerMutationAuthority(store, {
      beginAttempt: async () => "018f0000-0000-7000-8000-000000000001",
      finalizeAttempt: async () => undefined,
      keep: async (_requestId, rawCommand) => {
        delivered.push({ decision: "keep", command: rawCommand });
        return 7;
      },
      discard: async (_requestId, rawCommand) => {
        delivered.push({ decision: "discard", command: rawCommand });
      },
    });
    try {
      await expect(authority.keep(`req_${"k".repeat(26)}`, command)).resolves.toBe(7);
      await expect(authority.discard(`req_${"d".repeat(26)}`, command)).resolves.toBeUndefined();
      expect(delivered).toEqual([
        { decision: "keep", command },
        { decision: "discard", command },
      ]);
      expect(getterCalls).toBe(0);
    } finally {
      store.close();
    }
  });

  it("captures planner output before pipeline normalization and validation", async () => {
    const { store, plan } = await previewFixture();
    let getterCalls = 0;
    const hostilePlan = (): unknown => {
      const value = { ...plan };
      Object.defineProperty(value, "migration", {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return plan.migration;
        },
      });
      return value;
    };
    const planner: Planner = {
      requestPlan: async (): Promise<PlannerResult> => ({
        ok: true, plan: hostilePlan(), raw: "hostile plan",
      }),
      requestRepair: async (): Promise<PlannerResult> => ({
        ok: true, plan: hostilePlan(), raw: "hostile repair",
      }),
    };
    try {
      const result = await new MutationPipeline(
        createInProcessPlannerMutationAuthority(store), planner,
      ).run("add status to projects");
      expect(result).toMatchObject({ status: "failed", stage: "validate", repaired: true });
      expect(getterCalls).toBe(0);
    } finally {
      store.close();
    }
  });
});
