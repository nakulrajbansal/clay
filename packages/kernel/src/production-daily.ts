import { z } from "zod";
import { DailySourceLibraryV1 } from "@clay/schema/daily-home";
import { ClayError } from "./errors";
import { DAILY_TIME_ZONE_SETTING, localCalendarContext } from "./daily-calendar";
import { DAILY_NAVIGATION_SETTING, loadDailyNavigationState } from "./daily-navigation";
import { DAILY_SOURCE_LIBRARY_SETTING, loadDailySourceLibrary, recoverableDailySourceRevision, resolveDailySourceProfiles } from "./daily-source-profile";
import { PRODUCTION_STORE_PRIMITIVES as storeOps, type ClayStore } from "./store";

export const DAILY_CAPTURE_LEDGER = "daily_capture_receipts_v1";
const lastTable = "quick_capture_last_table_v1";
const name = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/);
const tableId = z.string().regex(/^tbl_[0-9a-f-]{36}$/);
const revision = z.number().int().nonnegative().safe();
const rowId = z.string().uuid();
const captureLedger = z.object({ schema: z.literal(1), entries: z.array(z.object({
  id: rowId, tableId, table: name,
}).strict()).max(200) }).strict();
const dailyRequest = z.discriminatedUnion("route", [
  z.object({ route: z.literal("daily.source"), payload: z.object({ expectedRevision: revision, value: DailySourceLibraryV1 }).strict() }),
  z.object({ route: z.literal("daily.navigation"), payload: z.object({ expectedRevision: revision, value: z.unknown() }).strict() }),
  z.object({ route: z.literal("daily.timeZone"), payload: z.object({ timeZone: z.string().min(1).max(128) }).strict() }),
  z.object({ route: z.literal("daily.capture"), payload: z.object({ table: name, tableId, row: z.record(z.unknown()) }).strict() }),
  z.object({ route: z.literal("daily.undoCapture"), payload: z.object({ batchId: rowId }).strict() }),
]);
export type CapturedDaily = z.infer<typeof dailyRequest> & { requestId: string };

/** Input is already deeply descriptor-captured and charged to the full 2 MB envelope. */
export function captureDaily(requestId: string, route: string, payload: unknown): CapturedDaily {
  const parsed = dailyRequest.parse({ route, payload });
  if (parsed.route === "daily.navigation") loadDailyNavigationState(parsed.payload.value);
  if (parsed.route === "daily.timeZone") localCalendarContext("2026-01-01T00:00:00.000Z", parsed.payload.timeZone);
  return { requestId, ...parsed };
}

function conflict(message: string): never { throw new ClayError("E_CONFLICT", message); }
function read(store: ClayStore, key: string): unknown { return storeOps.getSetting.call(store, key); }
function write(store: ClayStore, key: string, value: unknown): void { storeOps.setSetting.call(store, key, value); }

export function executeDaily(store: ClayStore, request: CapturedDaily): unknown {
  const registry = storeOps.validationRegistrySnapshot.call(store);
  switch (request.route) {
    case "daily.timeZone": {
      const current = read(store, DAILY_TIME_ZONE_SETTING);
      if (current !== undefined) {
        if (typeof current !== "string") conflict("stored Daily Home timezone needs recovery");
        localCalendarContext("2026-01-01T00:00:00.000Z", current as string);
        return current;
      }
      write(store, DAILY_TIME_ZONE_SETTING, request.payload.timeZone);
      return request.payload.timeZone;
    }
    case "daily.source": {
      const raw = read(store, DAILY_SOURCE_LIBRARY_SETTING);
      let current: unknown;
      let currentRevision: number;
      try {
        const parsed = loadDailySourceLibrary(raw);
        current = parsed; currentRevision = parsed.revision;
      } catch {
        // The setup UI offers an explicit reset, not arbitrary replacement of
        // unreadable settings. Its recovered revision must still win the CAS.
        current = raw; currentRevision = recoverableDailySourceRevision(raw);
        if (request.payload.value.profiles.length) conflict("reset damaged source setup before selecting sources");
      }
      const next = request.payload.value;
      if (currentRevision !== request.payload.expectedRevision) return { ok: false, current };
      if (next.revision !== currentRevision + 1 || !Number.isSafeInteger(next.revision)) conflict("source revision must advance exactly once");
      if (resolveDailySourceProfiles(registry, next).issues.length) conflict("source fields changed or are not compatible; review setup again");
      write(store, DAILY_SOURCE_LIBRARY_SETTING, next);
      return { ok: true, current: next };
    }
    case "daily.navigation": {
      const current = loadDailyNavigationState(read(store, DAILY_NAVIGATION_SETTING));
      const next = loadDailyNavigationState(request.payload.value);
      if (current.revision !== request.payload.expectedRevision) return { ok: false, current };
      if (next.revision !== current.revision + 1 || !Number.isSafeInteger(next.revision)) conflict("navigation revision must advance exactly once");
      // Old dangling references can be removed; new references must resolve now.
      const existing = new Set([...current.favorites, ...current.recents].map(item => `${item.tableId}/${item.rowId}`));
      for (const ref of [...next.favorites, ...next.recents]) {
        if (existing.has(`${ref.tableId}/${ref.rowId}`)) continue;
        const tables = [...registry.values()].filter(table => !table.inactive && table.semantic?.tableId === ref.tableId);
        if (tables.length !== 1 || !storeOps.query.call(store, { from: tables[0]!.name,
          where: [{ field: "id", op: "eq", value: ref.rowId }], limit: 1 }).length)
          conflict("navigation record is no longer available");
      }
      write(store, DAILY_NAVIGATION_SETTING, next);
      return { ok: true, current: next };
    }
    case "daily.capture": {
      const { table, tableId: expectedId, row } = request.payload;
      const registered = registry.get(table);
      if (!registered || registered.inactive || registered.semantic?.tableId !== expectedId)
        conflict("capture record type changed; choose it again");
      const ledger = captureLedger.parse(read(store, DAILY_CAPTURE_LEDGER) ?? { schema: 1, entries: [] });
      const receipt = storeOps.applyBatch.call(store, { source: "user", summary: `Quick capture in ${table}`,
        mutations: [{ kind: "insert", table, row }] });
      if (receipt.created.length !== 1 || receipt.created[0]!.table !== table) conflict("capture receipt failed readback");
      write(store, lastTable, expectedId);
      write(store, DAILY_CAPTURE_LEDGER, { schema: 1,
        entries: [{ id: receipt.id, tableId: expectedId, table }, ...ledger.entries].slice(0, 200) });
      return receipt;
    }
    case "daily.undoCapture": {
      const ledger = captureLedger.parse(read(store, DAILY_CAPTURE_LEDGER) ?? { schema: 1, entries: [] });
      const entry = ledger.entries.find(item => item.id === request.payload.batchId);
      if (!entry || registry.get(entry.table)?.semantic?.tableId !== entry.tableId)
        conflict("capture Undo is outside its retained recovery window or record type changed");
      return storeOps.undoBatch.call(store, request.payload.batchId);
    }
  }
}
