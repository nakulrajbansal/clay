import { describe, expect, it } from "vitest";
import {
  ClayStore,
  MutationPipeline,
  createInProcessPlannerMutationAuthority,
  deriveInverse,
  type ForwardOpT,
  type Planner,
  type PlannerResult,
  type PreviewShadow,
} from "../src/index";

const REQUEST_ID = `req_${"a".repeat(26)}`;

class OnePlan implements Planner {
  constructor(private readonly plan: unknown) {}
  async requestPlan(): Promise<PlannerResult> {
    return { ok: true, plan: this.plan, raw: JSON.stringify(this.plan) };
  }
  async requestRepair(): Promise<PlannerResult> {
    return { ok: false, error: { code: "E_MODEL", message: "unexpected repair" } };
  }
}

async function fixture(): Promise<{
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
      migration: {
        operations,
        inverse: deriveInverse(operations, store.registrySnapshot()),
      },
      panels: [],
      remove_panels: [],
      confidence: 1,
    },
  };
}

describe("prepared planner preview boundary", () => {
  it("returns immutable exact-base data without a live Store or PreviewHandle action", async () => {
    const { store, plan } = await fixture();
    const plannerAuthority = createInProcessPlannerMutationAuthority(store);
    try {
      const result = await new MutationPipeline(
        plannerAuthority,
        new OnePlan(plan),
      ).run("add status to projects");
      if (result.status !== "preview") throw new Error(JSON.stringify(result));

      expect(Reflect.ownKeys(result.preview).sort()).toEqual([
        "command", "plan", "shadow", "version",
      ]);
      expect(Reflect.get(result.preview, "keep")).toBeUndefined();
      expect(Reflect.get(result.preview, "discard")).toBeUndefined();
      expect(Reflect.get(result.preview, "store")).toBeUndefined();
      expect(Object.isFrozen(result.preview.command)).toBe(true);
      expect(Object.isFrozen(result.preview.command.base)).toBe(true);
      expect(Object.isFrozen(result.preview.command.plan)).toBe(true);
      expect(Object.isFrozen(result.preview.command.plan.migration?.operations)).toBe(true);
      expect(result.preview.command).toMatchObject({
        schema: 1,
        attemptId: result.attemptId,
        base: { version: 1, shapeSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
        intent: "add status to projects",
        semanticAssignments: { schema: 1, version: 2, origin: "model" },
      });
      expect(() => store.query({ from: "projects", select: ["status"] })).toThrow();
      expect(result.preview.shadow.query({ from: "projects", select: ["status"] })).toEqual([]);

      await plannerAuthority.discard(REQUEST_ID, result.preview.command);
      result.preview.shadow.close();
    } finally {
      store.close();
    }
  });

  it("rejects an ABA stale base even when the version number is reused", async () => {
    const { store, plan } = await fixture();
    const authority = createInProcessPlannerMutationAuthority(store);
    try {
      const result = await new MutationPipeline(authority, new OnePlan(plan))
        .run("add status to projects");
      if (result.status !== "preview") throw new Error(JSON.stringify(result));

      const extra: ForwardOpT[] = [{
        op: "add_column", table: "projects",
        column: { name: "note", type: "text", required: false },
      }];
      store.commit({
        intent: "concurrent", summary: "Concurrent shape.",
        migration: {
          operations: extra,
          inverse: deriveInverse(extra, store.registrySnapshot()),
        },
      });
      store.rollbackTo(0, { truncate: true });
      const replacement: ForwardOpT[] = [{
        op: "create_table", table: "other",
        columns: [{ name: "name", type: "text", required: true }],
      }];
      store.commit({
        intent: "replacement", summary: "Different version one.",
        migration: {
          operations: replacement,
          inverse: deriveInverse(replacement, store.registrySnapshot()),
        },
      });
      expect(store.headVersion()).toBe(result.preview.command.base.version);

      await expect(authority.keep(REQUEST_ID, result.preview.command))
        .rejects.toMatchObject({ code: "E_CONFLICT" });
      expect(store.headVersion()).toBe(1);
      await authority.discard(`req_${"d".repeat(26)}`, result.preview.command);
      result.preview.shadow.close();
    } finally {
      store.close();
    }
  });

  it("closes a failed smoke shadow before running the single repair", async () => {
    const { store, plan } = await fixture();
    const authority = createInProcessPlannerMutationAuthority(store);
    const plans: unknown[] = [plan, plan];
    const planner: Planner = {
      requestPlan: async (): Promise<PlannerResult> => ({
        ok: true, plan: plans.shift(), raw: "first",
      }),
      requestRepair: async (): Promise<PlannerResult> => ({
        ok: true, plan: plans.shift(), raw: "repair",
      }),
    };
    const shadows: PreviewShadow[] = [];
    try {
      const result = await new MutationPipeline(authority, planner, {
        smokeTest: async shadow => {
          shadows.push(shadow);
          if (shadows.length === 1) throw new Error("first smoke failed");
        },
      }).run("add status to projects");
      expect(result).toMatchObject({ status: "preview", repaired: true });
      expect(() => shadows[0]?.query({ from: "projects" }))
        .toThrow(/shadow is closed/i);
      if (result.status === "preview") {
        await authority.discard(`req_${"s".repeat(26)}`, result.preview.command);
        result.preview.shadow.close();
      }
    } finally {
      store.close();
    }
  });

  it("repairs a structural no-op once and then fails without a preview commit", async () => {
    const { store } = await fixture();
    const noOp = {
      api: 1 as const,
      summary: "No visible change.",
      user_facing_diff: [],
      clarifying_question: null,
      assumptions: [],
      migration: null,
      panels: [],
      remove_panels: [],
      confidence: 0.9,
    };
    const queue: unknown[] = [noOp, noOp];
    const planner: Planner = {
      requestPlan: async (): Promise<PlannerResult> => ({
        ok: true, plan: queue.shift(), raw: "first",
      }),
      requestRepair: async (): Promise<PlannerResult> => ({
        ok: true, plan: queue.shift(), raw: "repair",
      }),
    };
    try {
      const result = await new MutationPipeline(
        createInProcessPlannerMutationAuthority(store), planner,
      ).run("make it better");
      expect(result).toMatchObject({ status: "failed", stage: "validate", repaired: true });
      expect(store.headVersion()).toBe(1);
      expect(store.attemptStats()).toMatchObject({ failed: 1, kept: 0 });
    } finally {
      store.close();
    }
  });
});
