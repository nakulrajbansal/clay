import { ForwardOp } from "@clay/schema";
import type { DbDriver } from "./db";
import { ClayError } from "./errors";
import type { Registry } from "./registry";
import { isFieldId, isTableId } from "./semantic";

const SAFE_INDEX = /^idx_[a-z][a-z0-9_]{0,40}_[a-z][a-z0-9_]{0,40}$/;

export type ActiveUserIndex = {
  version: number;
  operationIndex: number;
  tableId: string;
  fieldId: string;
  active: boolean;
};

function invalid(message: string): ClayError {
  return new ClayError("E_STATE_DIGEST_INVALID", message);
}

export function userIndexAuthorities(
  driver: DbDriver,
  registry: Registry,
): Map<string, ActiveUserIndex> {
  const cursorRows = driver.select(
    "SELECT value_json FROM sys.settings WHERE key = 'current_version'",
  );
  if (cursorRows.length !== 1 || typeof cursorRows[0]!.value_json !== "string")
    throw invalid("current version is unavailable");
  const currentVersion = JSON.parse(cursorRows[0]!.value_json);
  if (!Number.isSafeInteger(currentVersion) || currentVersion < 0)
    throw invalid("current version is invalid");

  const active = new Map<string, ActiveUserIndex>();
  for (const row of driver.select(
    "SELECT version, migration_json FROM sys.version_log ORDER BY version",
  )) {
    if (typeof row.version !== "number" || !Number.isSafeInteger(row.version)
        || (row.migration_json !== null && typeof row.migration_json !== "string"))
      throw invalid("index migration history is invalid");
    const version = row.version;
    const operations = row.migration_json === null ? []
      : ForwardOp.array().parse(JSON.parse(row.migration_json));
    operations.forEach((operation, operationIndex) => {
      if (operation.op !== "add_index") return;
      const name = `idx_${operation.table}_${operation.column}`;
      if (!SAFE_INDEX.test(name)) throw invalid("index migration identity is invalid");
      const matches: ActiveUserIndex[] = [];
      for (const table of registry.values()) {
        if (!table.semantic || !isTableId(table.semantic.tableId)) throw invalid("table identity is invalid");
        for (const column of table.columns) {
          if (!column.semantic || !isFieldId(column.semantic.fieldId))
            throw invalid("field identity is invalid");
          if (column.semantic.events.some(event =>
            event.version === version && event.operationIndex === operationIndex)) {
            matches.push({
              version,
              operationIndex,
              tableId: table.semantic.tableId,
              fieldId: column.semantic.fieldId,
              active: version <= currentVersion,
            });
          }
        }
      }
      if (matches.length !== 1) throw invalid("index semantic authorization is ambiguous");
      const prior = active.get(name);
      if (prior && (prior.tableId !== matches[0]!.tableId || prior.fieldId !== matches[0]!.fieldId))
        throw invalid("index semantic authorization collides");
      if (!prior) active.set(name, matches[0]!);
      else if (matches[0]!.active && !prior.active) active.set(name, { ...prior, active: true });
    });
  }
  return active;
}
