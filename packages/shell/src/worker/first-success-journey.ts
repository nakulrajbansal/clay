import type { ClayStore, DbDriver, QueryRow } from "@clay/kernel";
import {
  FIRST_SUCCESS_SETTING_KEY,
  applyFirstSuccessEvent,
  emptyFirstSuccessState,
  parseFirstSuccessState,
  type FirstSuccessState,
} from "../app/first-success-state";
import { readSampleProvenance } from "../shells/sample-provenance";

export type EverydayActionTarget = {
  table: string;
  rowId: string;
};

export type CanonicalEverydayActionRequest = EverydayActionTarget & {
  action: "open";
};

const TABLE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;

function validateCoordinate(table: string, rowId: string): void {
  if (!TABLE_NAME.test(table) || rowId.length < 1 || rowId.length > 128)
    throw new Error("Everyday-action record coordinate is invalid");
}

function sampleCoordinates(store: ClayStore): Set<string> {
  return new Set(readSampleProvenance(store)
    .filter(entry => entry.tableActive && entry.rowState === "active")
    .map(entry => JSON.stringify([entry.tableName, entry.rowId])));
}

function coordinate(table: string, rowId: string): string {
  return JSON.stringify([table, rowId]);
}

function canonicalActiveRow(
  store: ClayStore,
  samples: ReadonlySet<string>,
  table: string,
  rowId: string,
): QueryRow | null {
  validateCoordinate(table, rowId);
  if (samples.has(coordinate(table, rowId))) return null;
  const row = store.query({
    from: table,
    where: [{ field: "id", op: "eq", value: rowId }],
    limit: 1,
  })[0] ?? null;
  return row && String(row.id) === rowId && row.deleted_at == null ? row : null;
}

/** Returns the newest exact coordinate that trusted provenance classifies as
 * user-owned. Values stay in the worker; the shell receives only a deep link. */
export function findEverydayActionTarget(store: ClayStore): EverydayActionTarget | null {
  const samples = sampleCoordinates(store);
  let newest: { target: EverydayActionTarget; updatedAt: string } | null = null;
  for (const table of store.registrySnapshot().values()) {
    if (table.inactive) continue;
    let afterId: string | null = null;
    while (true) {
      const rows = store.query({
        from: table.name,
        orderBy: [{ field: "id", dir: "asc" }],
        limit: 500,
        ...(afterId ? { where: [{ field: "id", op: "gt", value: afterId }] } : {}),
      });
      for (const row of rows) {
        const rowId = String(row.id);
        if (samples.has(coordinate(table.name, rowId))) continue;
        const updatedAt = typeof row.updated_at === "string" ? row.updated_at : "";
        const target = { table: table.name, rowId };
        if (!newest || updatedAt > newest.updatedAt
            || (updatedAt === newest.updatedAt
              && coordinate(target.table, target.rowId)
                < coordinate(newest.target.table, newest.target.rowId)))
          newest = { target, updatedAt };
      }
      if (rows.length < 500) break;
      afterId = String(rows.at(-1)!.id);
    }
  }
  return newest?.target ?? null;
}

/** Worker authority for the everyday milestone. The user-visible open is
 * accepted only when an exact, active, non-sample row is read back from the
 * canonical store. Evidence validation and progress persistence share the
 * same physical transaction, so a fabricated shell event cannot advance it. */
export async function completeEverydayActionFromCanonicalReadback(
  driver: DbDriver,
  store: ClayStore,
  request: CanonicalEverydayActionRequest,
): Promise<FirstSuccessState> {
  if (request.action !== "open")
    throw new Error("Everyday-action evidence is invalid");
  return driver.tx(() => {
    const samples = sampleCoordinates(store);
    if (!canonicalActiveRow(store, samples, request.table, request.rowId))
      throw new Error("Everyday action did not read back a canonical real record");

    const stored = store.getSetting<unknown>(FIRST_SUCCESS_SETTING_KEY);
    const current = stored === null || stored === undefined
      ? emptyFirstSuccessState() : parseFirstSuccessState(stored);
    const applied = applyFirstSuccessEvent(current, {
      type: "everyday_action", action: request.action, changed: true, sample: false,
    });
    if (applied === current) {
      if (current.steps.everyday.state === "complete") return current;
      throw new Error("The first real record must be verified before an everyday action");
    }
    if (current.revision >= Number.MAX_SAFE_INTEGER)
      throw new Error("First-success progress revision cannot advance");
    const next: FirstSuccessState = { ...applied, revision: current.revision + 1 };
    store.setSetting(FIRST_SUCCESS_SETTING_KEY, next);
    return next;
  });
}
