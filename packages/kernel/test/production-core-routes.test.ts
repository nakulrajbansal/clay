import { describe, expect, it } from "vitest";
import { ClayStore, deriveInverse, type ForwardOpT } from "../src/index";

const CORE_GRAPH_METHODS = [
  "commit",
  "currentVersion",
  "getEntry",
  "getSetting",
  "headVersion",
  "livePanels",
  "prepareSemanticAssignments",
  "renamePanel",
  "rollbackTo",
  "setSetting",
] as const;

function replaceCoreGraphMethods(): () => void {
  const prototype = ClayStore.prototype as unknown as Record<string, unknown>;
  const descriptors = new Map<string, PropertyDescriptor>();
  for (const name of CORE_GRAPH_METHODS) {
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

describe("production core route Store primitives", () => {
  it("keeps rename and rollback on the captured graph before and after route loading", async () => {
    const renameStore = await ClayStore.openMemory();
    const rollbackStore = await ClayStore.openMemory();
    try {
      renameStore.commit({
        intent: "seed panel",
        summary: "Added project table.",
        migration: null,
        panels: [{
          panel_id: "project_table",
          title: "Projects",
          placement: { region: "main", order: 0 },
          code: "export default function(clay){}",
          declared_queries: [],
          declared_writes: [],
        }],
      });

      const create: ForwardOpT[] = [{
        op: "create_table",
        table: "projects",
        columns: [{ name: "name", type: "text", required: true }],
      }];
      rollbackStore.commit({
        intent: "create projects",
        summary: "Created projects.",
        migration: { operations: create, inverse: deriveInverse(create, rollbackStore.registrySnapshot()) },
      });
      const add: ForwardOpT[] = [{
        op: "add_column",
        table: "projects",
        column: { name: "status", type: "text", required: false },
      }];
      rollbackStore.commit({
        intent: "add status",
        summary: "Added status.",
        migration: { operations: add, inverse: deriveInverse(add, rollbackStore.registrySnapshot()) },
      });

      const restoreBeforeLoad = replaceCoreGraphMethods();
      let routes: typeof import("../src/production-core-routes");
      try {
        routes = await import("../src/production-core-routes");
      } finally {
        restoreBeforeLoad();
      }

      const rename = routes.captureCoreMutation(
        `req_${"r".repeat(26)}`,
        "panel.rename",
        { panelId: "project_table", title: "Pinned title" },
      );
      const rollback = routes.captureCoreMutation(
        `req_${"b".repeat(26)}`,
        "timeline.makeLatest",
        { version: 1 },
      );
      if (!rename || !rollback) throw new Error("core route capture failed");

      const restoreAfterLoad = replaceCoreGraphMethods();
      try {
        routes.executeCapturedCoreMutation(renameStore, rename);
        routes.executeCapturedCoreMutation(rollbackStore, rollback);
      } finally {
        restoreAfterLoad();
      }

      expect(renameStore.livePanels()[0]?.title).toBe("Pinned title");
      expect(rollbackStore.history().map(entry => entry.version)).toEqual([1]);
      expect(rollbackStore.registrySnapshot().get("projects")?.columns
        .some(column => column.name === "status")).toBe(false);
    } finally {
      renameStore.close();
      rollbackStore.close();
    }
  });
});
