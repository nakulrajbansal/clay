import { copyDatabase, type DatabaseCopyShape, type DbDriver } from "./db";
import { ClayError } from "./errors";
import { createTableSql } from "./migrate";
import type { Registry } from "./registry";
import { ClayStore } from "./store";

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value))
    throw new ClayError("E_VALIDATION", "generation copy contains an invalid identifier");
  return `"${value}"`;
}

function assertFreshTarget(driver: DbDriver): void {
  const main = driver.select(
    `SELECT type,name FROM main.sqlite_master
     WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`,
  );
  const system = driver.select(
    `SELECT type,name FROM sys.sqlite_master
     WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`,
  );
  if (main.length !== 0 || system.length !== 0)
    throw new ClayError("E_CATALOG_CONFLICT", "generation target is not physically fresh");
}

function copyShape(source: DbDriver, registry: Registry): DatabaseCopyShape {
  const tables = [...registry.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(table => ({
      name: table.name,
      sql: createTableSql(table, { includeInactive: true }),
    }));
  const indexes = source.select(
    `SELECT name,tbl_name FROM main.sqlite_master
     WHERE type = 'index' AND sql IS NOT NULL
       AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'idx_row_history_%'
     ORDER BY name`,
  ).map(row => {
    if (typeof row.name !== "string" || typeof row.tbl_name !== "string")
      throw new ClayError("E_VALIDATION", "generation copy index metadata is invalid");
    const name = row.name;
    const table = row.tbl_name;
    const columns = source.select(`PRAGMA main.index_info(${quoteIdentifier(name)})`);
    if (columns.length !== 1 || typeof columns[0]!.name !== "string")
      throw new ClayError("E_VALIDATION", `generation copy index '${name}' is not canonical`);
    const column = columns[0]!.name;
    return { name, table, column };
  });
  return { tables, indexes };
}

/**
 * Copy one canonical app into a brand-new generation. The source is read-only;
 * refusing a non-empty destination prevents this primitive from ever becoming
 * an in-place replacement path.
 */
export function copyAppStateToFreshTarget(
  source: DbDriver,
  target: DbDriver,
  registry: Registry,
): ClayStore {
  assertFreshTarget(target);
  const shape = copyShape(source, registry);
  let copied: ClayStore | null = null;
  copyDatabase(source, target, shape, () => {
    copied = ClayStore.fromDriver(target, { requireSemanticRegistry: true });
    const issues = copied.verifyIntegrity();
    if (issues.length !== 0)
      throw new ClayError("E_VALIDATION", `generation copy failed read-back: ${issues.join("; ")}`);
  });
  if (!copied)
    throw new ClayError("E_VALIDATION", "generation copy did not produce a readable store");
  return copied;
}
