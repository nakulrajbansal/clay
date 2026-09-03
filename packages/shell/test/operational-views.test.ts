import { describe, expect, it } from "vitest";
import type { SemanticSchemaTraceV1 } from "@clay/kernel";
import {
  createOperationalView, loadOperationalViews, reconcileOperationalViews,
  saveOperationalView, type OperationalViewLibrary,
} from "../src/app/operational-views";

const library: OperationalViewLibrary = {
  format: 1, revision: 2, views: [{
    id: "view_018f0000000070008000000000000001",
    name: "Overdue work", table: "tasks", search: "",
    filters: [{ field: "due", op: "older_than_days", value: 0 }],
    orderBy: [{ field: "due", dir: "asc" }], visibleFields: ["name", "due"],
    createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z",
  }],
};

describe("operational views", () => {
  it("loads valid state and fails closed on future or malformed envelopes", () => {
    expect(loadOperationalViews(library)).toEqual(library);
    expect(loadOperationalViews({ ...library, format: 2 })).toEqual({ format: 1, revision: 0, views: [] });
    expect(loadOperationalViews({ ...library, views: [{ name: "missing identity" }] }))
      .toEqual({ format: 1, revision: 0, views: [] });
    const malformed = [
      { field: "status", op: "in", value: "not-an-array" },
      { field: "due", op: "within_days", value: -1 },
      { field: "status", op: "is_null", value: "unexpected" },
    ];
    for (const filter of malformed) {
      expect(loadOperationalViews({ ...library, views: [{
        ...library.views[0], filters: [filter],
      }] })).toEqual({ format: 1, revision: 0, views: [] });
    }
    expect(loadOperationalViews({ ...library, views: [{
      ...library.views[0], createdAt: "not-a-date",
    }] })).toEqual({ format: 1, revision: 0, views: [] });
  });

  it("creates bounded durable view state and reconciles renamed or removed fields", () => {
    const view = createOperationalView({
      name: "Today", table: "tasks", search: "open",
      filters: [{ field: "due", op: "within_days", value: 0 }],
      orderBy: [{ field: "due", dir: "asc" }], visibleFields: ["name", "due"],
    }, () => "2026-09-02T12:00:00.000Z", () => "018f0000-0000-7000-8000-000000000001");
    expect(view.id).toBe("view_018f0000000070008000000000000001");
    expect(() => createOperationalView({ ...view, name: "x".repeat(81) }))
      .toThrow(/80/);

    const reconciled = reconcileOperationalViews({ format: 1, revision: 1, views: [view] }, [{
      name: "tasks", columns: [
        { name: "title", type: "text", required: true },
        { name: "due_on", type: "date", required: false },
      ],
    }], { tasks: { name: "title", due: "due_on" } });
    expect(reconciled.views[0]).toMatchObject({
      visibleFields: ["title", "due_on"],
      filters: [{ field: "due_on" }], orderBy: [{ field: "due_on" }],
    });
  });

  it("resolves saved views by stable semantic ids after presentation renames", () => {
    const tableId = "tbl_018f0000-0000-7000-8000-000000000001";
    const fieldId = "fld_018f0000-0000-7000-8000-000000000002";
    const view = createOperationalView({
      name: "Open", table: "tasks", search: "",
      filters: [{ field: "status", op: "eq", value: "open" }],
      orderBy: [{ field: "status", dir: "asc" }], visibleFields: ["status"],
      identity: { tableId, filterFieldIds: [fieldId], orderFieldIds: [fieldId],
        visibleFieldIds: [fieldId] },
    });
    const trace = {
      v: 1, atVersion: 2,
      tables: [{ tableId, name: "work_items", label: "work items", aliases: ["tasks"], state: "visible" }],
      fields: [{ tableId, fieldId, tableName: "work_items", fieldName: "state",
        label: "state", aliases: ["status"], state: "visible" }],
      relationships: [], opBindings: [],
    } as unknown as SemanticSchemaTraceV1;
    const renamed = [{ name: "work_items", columns: [
      { name: "state", type: "enum" as const, required: false, values: ["open", "done"] },
    ] }];
    expect(reconcileOperationalViews(
      { format: 1, revision: 1, views: [view] }, renamed, {}, trace,
    ).views[0]).toMatchObject({
      table: "work_items", filters: [{ field: "state" }],
      orderBy: [{ field: "state" }], visibleFields: ["state"],
    });
  });

  it("persists with compare-and-set and retries one concurrent revision", async () => {
    let current: unknown = { format: 1, revision: 2, views: [] };
    let calls = 0;
    const storage = {
      getSetting: async <T,>() => current as T,
      compareAndSetSetting: async <T,>(_key: string, expected: number, value: T) => {
        calls++;
        if (calls === 1) {
          current = { format: 1, revision: expected + 1, views: [] };
          return { ok: false, current };
        }
        current = value;
        return { ok: true, current };
      },
    };
    const view = library.views[0]!;
    const saved = await saveOperationalView(storage, view);
    expect(saved.revision).toBe(4);
    expect(saved.views).toEqual([view]);
    expect(calls).toBe(2);
  });
});
