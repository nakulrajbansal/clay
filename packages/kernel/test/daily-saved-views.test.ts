import { describe, expect, it } from "vitest";
import type { RegTable } from "../src/index";
import { projectDailyHome, type DailyHomeProjectionReader } from "../src/daily-home-projection";

const appInstanceId = `app_${"h".repeat(26)}`;
const activeGenerationId = `gen_${"j".repeat(26)}`;
const tableId = "tbl_018f4c2a-7b31-7001-8000-000000000072";
const titleFieldId = "fld_018f4c2a-7b31-7001-8000-000000000073";
const dueFieldId = "fld_018f4c2a-7b31-7001-8000-000000000074";
const table = {
  name: "tasks", semantic: { tableId }, columns: [
    { name: "title", type: "text", semantic: { fieldId: titleFieldId } },
    { name: "due_on", type: "date", semantic: { fieldId: dueFieldId } },
  ],
} as unknown as RegTable;

describe("Daily Home saved-view projection", () => {
  it("projects persisted operational views as exact stable restoration routes", () => {
    const viewId = "view_018f4c2a7b3170018000000000000071";
    const viewLibrary = {
      format: 1, revision: 8,
      views: [{
        id: viewId, name: "Overdue clients", table: "tasks", search: "client",
        filters: [{ field: "due_on", op: "eq", value: "2026-09-06" }],
        orderBy: [{ field: "due_on", dir: "asc" }], visibleFields: ["title", "due_on"],
        identity: {
          tableId,
          filterFieldIds: [dueFieldId],
          orderFieldIds: [dueFieldId],
          visibleFieldIds: [titleFieldId, dueFieldId],
        },
        createdAt: "2026-09-05T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z",
      }],
    };
    const reader: DailyHomeProjectionReader = {
      registrySnapshot: () => new Map([[table.name, table]]),
      query: () => [], listNotifications: () => [],
      dailyHomeUnreadNotifications: () => ({ notifications: [], truncated: false }),
      headVersion: () => 11,
      getSetting: <T,>(key: string): T | undefined =>
        (key === "operational_views_v1" ? viewLibrary : undefined) as T | undefined,
    };

    const snapshot = projectDailyHome(reader, {
      appInstanceId, activeGenerationId,
      now: "2026-09-06T12:00:00.000Z", timeZone: "UTC",
    });

    expect(snapshot.sources.find(source => source.sourceId === "saved_view")?.page).toMatchObject({
      items: [{
        kind: "saved_view_projection", sourceId: "saved_view", savedViewId: viewId,
        title: "Overdue clients", route: { kind: "saved_view", savedViewId: viewId },
      }],
      counts: {
        sourceOccurrences: { kind: "exact", total: 1 },
        renderedUnique: { kind: "exact", total: 1 },
      },
    });
    expect(snapshot.sections.find(section => section.sectionId === "pinned")?.page.items)
      .toMatchObject([{ savedViewId: viewId, title: "Overdue clients" }]);
  });

  it("rejects every filter or ordering shape that DataView cannot faithfully restore", () => {
    const timestamps = {
      createdAt: "2026-09-05T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
    };
    const unsupported = ["gt", "gte", "lt", "lte", "in", "within_days", "older_than_days"]
      .map((op, index) => ({
        id: `view_${(index + 1).toString(16).padStart(32, "0")}`,
        name: `Unsupported ${op}`,
        table: "tasks",
        search: "",
        filters: [{
          field: "due_on",
          op,
          value: op === "in" ? ["2026-09-06"]
            : op === "within_days" || op === "older_than_days" ? 7 : "2026-09-06",
        }],
        orderBy: [],
        visibleFields: ["title"],
        identity: {
          tableId,
          filterFieldIds: [dueFieldId],
          orderFieldIds: [],
          visibleFieldIds: [titleFieldId],
        },
        ...timestamps,
      }));
    const views = [...unsupported, {
      id: `view_${"a".repeat(32)}`,
      name: "Two filters",
      table: "tasks",
      search: "",
      filters: [
        { field: "title", op: "contains", value: "client" },
        { field: "due_on", op: "eq", value: "2026-09-06" },
      ],
      orderBy: [],
      visibleFields: ["title"],
      identity: {
        tableId,
        filterFieldIds: [titleFieldId, dueFieldId],
        orderFieldIds: [],
        visibleFieldIds: [titleFieldId],
      },
      ...timestamps,
    }, {
      id: `view_${"b".repeat(32)}`,
      name: "Two sort clauses",
      table: "tasks",
      search: "",
      filters: [],
      orderBy: [{ field: "due_on", dir: "asc" }, { field: "title", dir: "desc" }],
      visibleFields: ["title"],
      identity: {
        tableId,
        filterFieldIds: [],
        orderFieldIds: [dueFieldId, titleFieldId],
        visibleFieldIds: [titleFieldId],
      },
      ...timestamps,
    }];
    const reader: DailyHomeProjectionReader = {
      registrySnapshot: () => new Map([[table.name, table]]),
      query: () => [],
      listNotifications: () => [],
      dailyHomeUnreadNotifications: () => ({ notifications: [], truncated: false }),
      headVersion: () => 11,
      getSetting: <T,>(key: string): T | undefined =>
        (key === "operational_views_v1"
          ? { format: 1, revision: 10, views } : undefined) as T | undefined,
    };

    const snapshot = projectDailyHome(reader, {
      appInstanceId, activeGenerationId,
      now: "2026-09-06T12:00:00.000Z", timeZone: "UTC",
    });
    const source = snapshot.sources.find(candidate => candidate.sourceId === "saved_view")!;
    expect(source.status).toBe("partial");
    expect(source.page.items).toEqual([]);
    expect(source.page.counts.sourceOccurrences).toMatchObject({
      kind: "partial",
      knownMinimum: 0,
      gaps: [{ sourceId: "saved_view", reason: "invalid_source", retryable: false }],
    });
  });

  it("marks semantically stale saved views partial instead of dropping constraints into a ready route", () => {
    const viewId = "view_018f4c2a7b3170018000000000000072";
    const missingFieldId = "fld_018f4c2a-7b31-7001-8000-000000000099";
    const reader: DailyHomeProjectionReader = {
      registrySnapshot: () => new Map([[table.name, table]]),
      query: () => [], listNotifications: () => [],
      dailyHomeUnreadNotifications: () => ({ notifications: [], truncated: false }),
      headVersion: () => 12,
      getSetting: <T,>(key: string): T | undefined => (key === "operational_views_v1" ? {
        format: 1, revision: 9, views: [{
          id: viewId, name: "Stale due view", table: "tasks", search: "",
          filters: [{ field: "removed_due", op: "older_than_days", value: 0 }],
          orderBy: [], visibleFields: ["title"],
          identity: {
            tableId, filterFieldIds: [missingFieldId], orderFieldIds: [],
            visibleFieldIds: [titleFieldId],
          },
          createdAt: "2026-09-05T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z",
        }],
      } : undefined) as T | undefined,
    };

    const snapshot = projectDailyHome(reader, {
      appInstanceId, activeGenerationId,
      now: "2026-09-06T12:00:00.000Z", timeZone: "UTC",
    });
    const source = snapshot.sources.find(candidate => candidate.sourceId === "saved_view")!;
    expect(source).toMatchObject({
      status: "partial",
      page: {
        items: [],
        counts: {
          sourceOccurrences: {
            kind: "partial", knownMinimum: 0,
            gaps: [{ sourceId: "saved_view", reason: "invalid_source", retryable: false }],
          },
          renderedUnique: {
            kind: "partial", knownMinimum: 0,
            gaps: [{ sourceId: "saved_view", reason: "invalid_source", retryable: false }],
          },
        },
      },
    });
    expect(snapshot.sections.find(section => section.sectionId === "pinned")?.page.items).toEqual([]);
  });
});
