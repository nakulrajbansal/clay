import { describe, expect, it } from "vitest";
import type { Query, QueryRow, RegTable } from "../src/index";
import {
  DAILY_SOURCE_LIBRARY_SETTING,
  projectDailyHome,
  type DailyHomeProjectionReader,
} from "../src/daily-home-projection";

const appInstanceId = `app_${"a".repeat(26)}`;
const activeGenerationId = `gen_${"b".repeat(26)}`;
const profileId = `dsp_${"c".repeat(26)}`;
const tableId = "tbl_018f4c2a-7b31-7001-8000-000000000001";
const titleFieldId = "fld_018f4c2a-7b31-7002-8000-000000000002";
const dueFieldId = "fld_018f4c2a-7b31-7003-8000-000000000003";
const doneFieldId = "fld_018f4c2a-7b31-7004-8000-000000000004";

const table = {
  name: "tasks",
  semantic: { tableId },
  columns: [
    { name: "title", type: "text", required: true, semantic: { fieldId: titleFieldId } },
    { name: "due_on", type: "date", required: false, semantic: { fieldId: dueFieldId } },
    { name: "done", type: "boolean", required: false, semantic: { fieldId: doneFieldId } },
  ],
} as unknown as RegTable;

const rows: QueryRow[] = [
  {
    id: "018f4c2a-7b31-7001-8000-000000000011",
    created_at: "2026-09-01T10:00:00.000Z",
    updated_at: "2026-09-05T10:00:00.000Z",
    title: "Overdue tax",
    due_on: "2026-09-05",
    done: false,
  },
  {
    id: "018f4c2a-7b31-7001-8000-000000000012",
    created_at: "2026-09-01T10:00:00.000Z",
    updated_at: "2026-09-06T08:00:00.000Z",
    title: "Send quote",
    due_on: "2026-09-06",
    done: false,
  },
  {
    id: "018f4c2a-7b31-7001-8000-000000000013",
    created_at: "2026-09-01T10:00:00.000Z",
    updated_at: "2026-09-06T09:00:00.000Z",
    title: "Already filed",
    due_on: "2026-09-05",
    done: true,
  },
  {
    id: "018f4c2a-7b31-7001-8000-000000000014",
    created_at: "2026-09-01T10:00:00.000Z",
    updated_at: "2026-09-06T09:30:00.000Z",
    title: "Future renewal",
    due_on: "2026-09-07",
    done: false,
  },
];

function reader(notifications: ReturnType<DailyHomeProjectionReader["listNotifications"]> = []): DailyHomeProjectionReader {
  return {
    registrySnapshot: () => new Map([[table.name, table]]),
    query: (query: Query) => {
      const after = query.where?.find(condition => condition.field === "id" && condition.op === "gt")?.value;
      return rows.filter(row => typeof after !== "string" || String(row.id) > after)
        .slice(0, query.limit ?? rows.length);
    },
    listNotifications: () => notifications,
    dailyHomeUnreadNotifications: () => ({
      notifications: notifications.filter(notification => !notification.read),
      truncated: false,
    }),
    headVersion: () => 7,
    getSetting: <T,>(key: string): T | undefined => {
      if (key === "sample_rows") return { format: 1, tables: {} } as T;
      if (key !== DAILY_SOURCE_LIBRARY_SETTING) return undefined;
      return {
        schema: 1,
        revision: 1,
        profiles: [{
          schema: 1,
          profileId,
          tableId,
          labelFieldId: titleFieldId,
          dueFieldId,
          completion: { kind: "boolean", fieldId: doneFieldId, completeValue: true },
          enabled: true,
        }],
      } as T;
    },
  };
}

describe("production Daily Home projection", () => {
  it("projects overdue and due-today work from reviewed canonical bindings", () => {
    const snapshot = projectDailyHome(reader(), {
      appInstanceId,
      activeGenerationId,
      now: "2026-09-06T12:00:00.000Z",
      timeZone: "UTC",
    });

    expect(snapshot.sections.find(section => section.sectionId === "due_today")?.page.items)
      .toMatchObject([
        { kind: "due_record", title: "Overdue tax", severity: "high" },
        { kind: "due_record", title: "Send quote", severity: "normal" },
      ]);
    expect(snapshot.sources.find(source => source.sourceId === "due_record")?.page.counts)
      .toEqual({
        sourceOccurrences: { kind: "exact", total: 2 },
        renderedUnique: { kind: "exact", total: 2 },
      });
    expect(snapshot.basis).toMatchObject({
      appInstanceId,
      activeGenerationId,
      localDate: "2026-09-06",
      schemaHead: "version:7",
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.sections[1]!.page.items)).toBe(true);
  });

  it("binds A-to-B-to-A row occurrences to monotonic native revisions", () => {
    const projectRevision = (revision: number, title: string, updatedAt: string) => {
      const versionedRows = rows.map(row => row.id === rows[0]!.id
        ? { ...row, title, updated_at: updatedAt } : row);
      const base = reader();
      const revisionReader = {
        ...base,
        query: (query: Query) => {
          const after = query.where?.find(condition =>
            condition.field === "id" && condition.op === "gt")?.value;
          return versionedRows.filter(row => typeof after !== "string" || String(row.id) > after)
            .slice(0, query.limit ?? versionedRows.length);
        },
        dailyHomeRecordRevisions: () => ({
          watermark: revision,
          truncated: false,
          entries: versionedRows.map((row, index) => ({
            table: "tasks", rowId: String(row.id), revision: index === 0 ? revision : index + 10,
          })),
        }),
        dailyHomeNotificationWatermark: () => "notifications:0",
      } as DailyHomeProjectionReader;
      return projectDailyHome(revisionReader, {
        appInstanceId, activeGenerationId,
        now: "2026-09-06T12:00:00.000Z", timeZone: "UTC",
      });
    };

    const first = projectRevision(21, "A", "2026-09-05T10:00:00.000Z");
    const second = projectRevision(22, "B", "2026-09-05T10:00:01.000Z");
    const third = projectRevision(23, "A", "2026-09-05T10:00:02.000Z");
    const occurrence = (snapshot: ReturnType<typeof projectDailyHome>) =>
      snapshot.sources.find(source => source.sourceId === "due_record")!.page.items
        .find(item => item.route.kind === "record" && item.route.rowId === rows[0]!.id)!;

    expect(new Set([first, second, third].map(snapshot => occurrence(snapshot).sourceGeneration)).size)
      .toBe(3);
    expect(new Set([first.snapshotDigest, second.snapshotDigest, third.snapshotDigest]).size).toBe(3);
    expect(third.sources.find(source => source.sourceId === "due_record")?.watermark)
      .toMatch(/^record-events:23:samples:[0-9a-f]{32}$/);
  });

  it("excludes trusted sample identities from every record adapter and fails malformed provenance partial", () => {
    const base = reader();
    const navigation = {
      schema: 1, revision: 2,
      favorites: [{ tableId, rowId: String(rows[0]!.id), pinnedAt: "2026-09-06T10:00:00.000Z" }],
      recents: [{ tableId, rowId: String(rows[0]!.id), openedAt: "2026-09-06T11:00:00.000Z" }],
    };
    const projectWithSamples = (sampleRows: unknown) => projectDailyHome({
      ...base,
      getSetting: <T,>(key: string): T | undefined => {
        if (key === "sample_rows") return sampleRows as T;
        if (key === "daily_navigation_v1") return navigation as T;
        return base.getSetting<T>(key);
      },
    }, {
      appInstanceId, activeGenerationId,
      now: "2026-09-06T12:00:00.000Z", timeZone: "UTC",
    });

    const excluded = projectWithSamples({
      format: 1,
      tables: { tasks: [rows[0]!.id] },
    });
    for (const sourceId of [
      "due_record", "favorite_record", "recently_changed_record", "recently_opened_record",
    ] as const) {
      const source = excluded.sources.find(candidate => candidate.sourceId === sourceId)!;
      expect(source.page.items.some(item =>
        item.route.kind === "record" && item.route.rowId === rows[0]!.id)).toBe(false);
    }

    for (const unsafe of [undefined, { format: 1, tables: { tasks: "not-an-id-list" } }]) {
      const snapshot = projectWithSamples(unsafe);
      for (const sourceId of [
        "due_record", "favorite_record", "recently_changed_record", "recently_opened_record",
      ] as const) {
        const source = snapshot.sources.find(candidate => candidate.sourceId === sourceId)!;
        expect(source.status).toBe("partial");
        expect(source.page.items).toEqual([]);
        expect(source.page.counts.renderedUnique).toMatchObject({
          kind: "partial",
          gaps: [{ sourceId, reason: "invalid_source", retryable: false }],
        });
      }
    }
  });

  it("marks recently changed partial when a table scan ends before excluded samples", () => {
    const scannedRows = Array.from({ length: 20_001 }, (_, index): QueryRow => ({
      id: `018f4c2a-7b31-7001-8000-${index.toString(16).padStart(12, "0")}`,
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-06T00:00:00.000Z",
      title: index === 20_000 ? "Unscanned user work" : `Starter ${index}`,
    }));
    const base = reader();
    const snapshot = projectDailyHome({
      ...base,
      query: (query: Query) => {
        const after = query.where?.find(condition =>
          condition.field === "id" && condition.op === "gt")?.value;
        return scannedRows.filter(row => typeof after !== "string" || String(row.id) > after)
          .slice(0, query.limit ?? scannedRows.length);
      },
      getSetting: <T,>(key: string): T | undefined => key === "sample_rows"
        ? { format: 1, tables: {
            tasks: scannedRows.slice(0, 20_000).map(row => row.id),
          } } as T
        : base.getSetting<T>(key),
    }, {
      appInstanceId, activeGenerationId,
      now: "2026-09-06T12:00:00.000Z", timeZone: "UTC",
    });

    const source = snapshot.sources.find(candidate =>
      candidate.sourceId === "recently_changed_record")!;
    expect(source.status).toBe("partial");
    expect(source.page.items).toEqual([]);
    expect(source.page.counts.sourceOccurrences).toEqual({
      kind: "partial",
      knownMinimum: 0,
      gaps: [{ sourceId: "recently_changed_record", reason: "limit", retryable: true }],
    });
  });

  it("queries unread notifications directly instead of filtering a bounded mixed page", () => {
    const notifications = Array.from({ length: 501 }, (_, index) => ({
      id: `018f4c2a-7b31-7001-8000-${(index + 100).toString(16).padStart(12, "0")}`,
      at: new Date(Date.parse("2026-09-06T12:00:00.000Z") - index).toISOString(),
      automationId: "auto_018f4c2a7b3170018000000000000021",
      runId: `018f4c2a-7b31-7001-8000-${(index + 700).toString(16).padStart(12, "0")}`,
      title: index === 500 ? "Old unread reminder" : `Read ${index}`,
      body: "Review locally.",
      table: null,
      recordId: null,
      read: index < 500,
    }));
    let genericReads = 0;
    let unreadReads = 0;
    const base = reader();
    const snapshot = projectDailyHome({
      ...base,
      listNotifications: (limit = 100) => {
        genericReads++;
        return notifications.slice(0, limit);
      },
      dailyHomeUnreadNotifications: () => {
        unreadReads++;
        return { notifications: [notifications[500]!], truncated: false };
      },
    }, {
      appInstanceId, activeGenerationId,
      now: "2026-09-06T12:00:00.000Z", timeZone: "UTC",
    });

    const source = snapshot.sources.find(candidate =>
      candidate.sourceId === "automation_notification")!;
    expect(genericReads).toBe(0);
    expect(unreadReads).toBe(1);
    expect(source.status).toBe("ready");
    expect(source.page.items).toMatchObject([{ title: "Old unread reminder" }]);
    expect(source.page.counts.sourceOccurrences).toEqual({ kind: "exact", total: 1 });
  });

  it("aggregates unread automation reminders with due work without copying either source", () => {
    const snapshot = projectDailyHome(reader([{
      id: "018f4c2a-7b31-7001-8000-000000000021",
      at: "2026-09-06T10:30:00.000Z",
      automationId: "auto_018f4c2a7b3170018000000000000021",
      runId: "018f4c2a-7b31-7001-8000-000000000022",
      title: "Invoice import needs review",
      body: "Three rows could not be matched.",
      table: null,
      recordId: null,
      read: false,
    }, {
      id: "018f4c2a-7b31-7001-8000-000000000023",
      at: "2026-09-06T09:30:00.000Z",
      automationId: "auto_018f4c2a7b3170018000000000000023",
      runId: "018f4c2a-7b31-7001-8000-000000000024",
      title: "Already reviewed",
      body: "This should stay out of the active inbox.",
      table: null,
      recordId: null,
      read: true,
    }]), {
      appInstanceId,
      activeGenerationId,
      now: "2026-09-06T12:00:00.000Z",
      timeZone: "UTC",
    });

    expect(snapshot.sections.find(section => section.sectionId === "needs_attention")?.page.items)
      .toMatchObject([{
        kind: "automation_notification",
        title: "Invoice import needs review",
        summary: "Three rows could not be matched.",
        route: {
          kind: "automation",
          automationId: "auto_018f4c2a7b3170018000000000000021",
        },
      }]);
    expect(snapshot.sources.find(source => source.sourceId === "automation_notification")?.page.counts)
      .toEqual({
        sourceOccurrences: { kind: "exact", total: 1 },
        renderedUnique: { kind: "exact", total: 1 },
      });
    expect(snapshot.aggregateCounts.sourceOccurrences).toMatchObject({
      kind: "partial",
      knownMinimum: 7,
    });
  });
});
