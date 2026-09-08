import { describe, expect, it } from "vitest";
import type { Query, QueryRow, RegTable } from "../src/index";
import { projectDailyHome, type DailyHomeProjectionReader } from "../src/daily-home-projection";
import {
  DAILY_NAVIGATION_SETTING,
  rememberDailyRecordOpened,
  toggleDailyFavorite,
  type DailyNavigationStorage,
} from "../src/daily-navigation";

const tableId = "tbl_018f4c2a-7b31-7001-8000-000000000041";
const titleId = "fld_018f4c2a-7b31-7001-8000-000000000042";
const firstId = "018f4c2a-7b31-7001-8000-000000000043";
const secondId = "018f4c2a-7b31-7001-8000-000000000044";
const appInstanceId = `app_${"c".repeat(26)}`;
const activeGenerationId = `gen_${"d".repeat(26)}`;

const table = {
  name: "tasks",
  semantic: { tableId, label: "Tasks", aliases: [] },
  columns: [{
    name: "title", type: "text", required: true,
    semantic: { fieldId: titleId, label: "Title", aliases: [] },
  }],
} as unknown as RegTable;

function queryRows(rows: QueryRow[], query: Query): QueryRow[] {
  const id = query.where?.find(clause => clause.field === "id" && clause.op === "eq")?.value;
  const after = query.where?.find(clause => clause.field === "id" && clause.op === "gt")?.value;
  return rows.filter(row => (typeof id !== "string" || row.id === id)
      && (typeof after !== "string" || String(row.id) > after))
    .slice(0, query.limit ?? rows.length);
}

describe("Daily Home favorites and recents", () => {
  it("persists only stable references, then restores current canonical record titles", async () => {
    let current: unknown;
    const storage: DailyNavigationStorage = {
      getSetting: async <T,>() => current as T | undefined,
      compareAndSetDailyNavigation: async <T,>(expectedRevision: number, value: T) => {
        const revision = typeof current === "object" && current !== null
          && typeof (current as { revision?: unknown }).revision === "number"
          ? (current as { revision: number }).revision : 0;
        if (revision !== expectedRevision) return { ok: false, current: current as T | undefined };
        current = value;
        return { ok: true, current: value };
      },
    };

    await rememberDailyRecordOpened(storage, { tableId, rowId: firstId },
      () => "2026-09-06T09:00:00.000Z");
    await toggleDailyFavorite(storage, { tableId, rowId: firstId },
      () => "2026-09-06T09:01:00.000Z");
    await rememberDailyRecordOpened(storage, { tableId, rowId: secondId },
      () => "2026-09-06T09:02:00.000Z");

    expect(current).toMatchObject({
      schema: 1,
      revision: 3,
      favorites: [{ tableId, rowId: firstId }],
      recents: [{ tableId, rowId: secondId }, { tableId, rowId: firstId }],
    });
    expect(JSON.stringify(current)).not.toContain("Old title");

    const rows: QueryRow[] = [{
      id: firstId, title: "Current favorite title",
      created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-06T10:00:00.000Z",
      deleted_at: null,
    }, {
      id: secondId, title: "Current recent title",
      created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-06T10:01:00.000Z",
      deleted_at: null,
    }];
    const reader: DailyHomeProjectionReader = {
      registrySnapshot: () => new Map([[table.name, table]]),
      query: query => queryRows(rows, query),
      listNotifications: () => [],
      dailyHomeUnreadNotifications: () => ({ notifications: [], truncated: false }),
      headVersion: () => 9,
      getSetting: <T,>(key: string): T | undefined => {
        if (key === "sample_rows") return { format: 1, tables: {} } as T;
        return (key === DAILY_NAVIGATION_SETTING ? current : undefined) as T | undefined;
      },
    };
    const snapshot = projectDailyHome(reader, {
      appInstanceId, activeGenerationId,
      now: "2026-09-06T12:00:00.000Z", timeZone: "UTC",
    });

    expect(snapshot.sources.find(source => source.sourceId === "favorite_record")?.page.items)
      .toMatchObject([{ title: "Current favorite title", route: { tableId, rowId: firstId } }]);
    expect(snapshot.sources.find(source => source.sourceId === "recently_opened_record")?.page.items)
      .toMatchObject([
        { title: "Current recent title", route: { tableId, rowId: secondId } },
        { title: "Current favorite title", route: { tableId, rowId: firstId } },
      ]);
    // One record is rendered once even when it occurs in favorite, recent, and
    // recently-changed sources; source occurrences retain all provenance.
    expect(snapshot.sections.find(section => section.sectionId === "continue")?.page.items
      .map(item => item.title)).toEqual(["Current recent title", "Current favorite title"]);
    expect(snapshot.sections.find(section => section.sectionId === "pinned")?.page.items).toEqual([]);
    expect(snapshot.sections.find(section => section.sectionId === "recently_opened")?.page.items).toEqual([]);
  });

  it("derives recently changed work directly from current canonical rows", () => {
    const rows: QueryRow[] = [{
      id: firstId, title: "Older task", created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-06T08:00:00.000Z", deleted_at: null,
    }, {
      id: secondId, title: "Newest task", created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-06T11:00:00.000Z", deleted_at: null,
    }];
    const reader: DailyHomeProjectionReader = {
      registrySnapshot: () => new Map([[table.name, table]]),
      query: query => queryRows(rows, query),
      listNotifications: () => [],
      dailyHomeUnreadNotifications: () => ({ notifications: [], truncated: false }),
      headVersion: () => 10,
      getSetting: <T,>(key: string): T | undefined => key === "sample_rows"
        ? { format: 1, tables: {} } as T : undefined,
    };
    const snapshot = projectDailyHome(reader, {
      appInstanceId, activeGenerationId,
      now: "2026-09-06T12:00:00.000Z", timeZone: "UTC",
    });

    expect(snapshot.sections.find(section => section.sectionId === "continue")?.page.items
      .map(item => item.title)).toEqual(["Newest task", "Older task"]);
    expect(snapshot.sources.find(source => source.sourceId === "recently_changed_record")?.page.counts)
      .toEqual({
        sourceOccurrences: { kind: "exact", total: 2 },
        renderedUnique: { kind: "exact", total: 2 },
      });
  });
});
