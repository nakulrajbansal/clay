import { describe, expect, it } from "vitest";
import { deriveInverse, type ForwardOpT } from "../src/migrate";
import { ClayStore } from "../src/store";

const PLANNER_GRAPH_METHODS = [
  "beginAttempt",
  "commit",
  "commitPreparedMutation",
  "finishAttempt",
  "headVersion",
  "livePanels",
  "prepareSemanticAssignments",
  "registrySnapshot",
] as const;

function replacePlannerGraphMethods(): () => void {
  const prototype = ClayStore.prototype as unknown as Record<string, unknown>;
  const descriptors = new Map<string, PropertyDescriptor>();
  for (const name of PLANNER_GRAPH_METHODS) {
    const descriptor = Object.getOwnPropertyDescriptor(ClayStore.prototype, name);
    if (!descriptor) throw new Error(`missing Store method '${name}'`);
    descriptors.set(name, descriptor);
    Object.defineProperty(prototype, name, {
      ...descriptor,
      value(): never { throw new Error(`replaced Store method '${name}' executed`); },
    });
  }
  return () => {
    for (const [name, descriptor] of descriptors)
      Object.defineProperty(prototype, name, descriptor);
  };
}

describe("planner Store primitive graph", () => {
  it("pins Preview, Keep, and Discard across nested calls after lazy authority loading", async () => {
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
    const plan = {
      api: 1 as const,
      summary: "Adds project status.",
      user_facing_diff: [{ kind: "add_field" as const, detail: "Add status to projects" }],
      clarifying_question: null,
      assumptions: [],
      migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
      panels: [],
      remove_panels: [],
      confidence: 1,
    };

    const plannerModule = await import("../src/planner-authority");

    try {
      const authority = plannerModule.createInProcessPlannerMutationAuthority(store);
      const restoreAfterLoad = replacePlannerGraphMethods();
      try {
        const attemptId = await authority.beginAttempt("add status to projects");
        const preview = await authority.preparePreview({
          attemptId,
          base: authority.capturePlanningBase().base,
          intent: "add status to projects",
          plan,
        });
        await expect(authority.keep(
          `req_${"k".repeat(26)}`, preview.command,
        )).resolves.toBe(2);
        preview.shadow.close();

        const discardAttempt = await authority.beginAttempt("discard another preview");
        const discardPreview = await authority.preparePreview({
          attemptId: discardAttempt,
          base: authority.capturePlanningBase().base,
          intent: "discard another preview",
          plan: {
            ...plan,
            migration: null,
            panels: [],
            remove_panels: ["unused_panel"],
          },
        });
        await expect(authority.discard(
          `req_${"d".repeat(26)}`, discardPreview.command,
        )).resolves.toBeUndefined();
        discardPreview.shadow.close();
      } finally {
        restoreAfterLoad();
      }
      expect(store.headVersion()).toBe(2);
      expect(store.attemptStats()).toMatchObject({ kept: 1, discarded: 1 });
    } finally {
      store.close();
    }
  });
});
