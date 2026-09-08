// In-process seeding helpers used by tests and non-authority callers. Browser
// production imports only the plain-data bundle from seed.ts.
import {
  ClayStore, deriveInverse, expandBlueprint, parseBlueprintDirective,
  type MigrationPlanT,
} from "@clay/kernel";
import {
  createStarterSeedBundle,
  type ShellTable,
  type StarterShellId,
} from "./seed";

const RELATIVE_STARTER_DAY = /^@clay\/starter-day:([+-]?\d{1,5})$/;

function chunk<T>(items: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    groups.push(items.slice(index, index + size));
  return groups;
}

function materializeSampleRow(
  table: ShellTable,
  row: Record<string, unknown>,
  seedInstant: string,
): Record<string, unknown> {
  const materialized = { ...row };
  for (const column of table.columns) {
    if (column.type !== "date") continue;
    const value = materialized[column.name];
    if (typeof value !== "string" || !value.startsWith("@clay/starter-day:")) continue;
    const match = RELATIVE_STARTER_DAY.exec(value);
    const offset = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(offset) || Math.abs(offset) > 36_500)
      throw new Error("starter seed relative date is invalid");
    const date = new Date(seedInstant);
    date.setDate(date.getDate() + offset);
    materialized[column.name] = date.toISOString().slice(0, 10);
  }
  return materialized;
}

export function seedStarterShell(store: ClayStore, id: StarterShellId): void {
  const bundle = createStarterSeedBundle(id);
  const seedInstant = new Date().toISOString();

  // Tables in commits of <=3 (invariant I5). Multi-table templates take
  // more than one commit; that is fine — they land before any panel.
  for (const group of chunk(bundle.tables, 3)) {
    const operations: MigrationPlanT["operations"] = group.map(table => ({
      op: "create_table", table: table.name,
      columns: table.columns.map(column => ({
        name: column.name, type: column.type, required: column.required,
        ...(column.values ? { values: column.values } : {}),
      })),
    }));
    store.commit({
      intent: "first run", summary: `Sets up ${group.map(table => table.name).join(", ")}.`,
      semanticOrigin: "seed",
      migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
    });
  }

  // All panels in one commit (a blank canvas commits an empty first version
  // so the app is "started" but carries nothing to reshape from).
  // Panels may be blueprint DIRECTIVES (ADR-029/030): expand them here
  // against the just-created registry — templates ride the same expansion
  // path model plans do, so the two can never drift.
  const isBlank = bundle.tables.length === 0;
  const panels = bundle.panels.map(panel => {
    const spec = parseBlueprintDirective(panel.code);
    if (spec === null) return panel;
    const expanded = expandBlueprint(spec, store.registrySnapshot());
    return {
      ...panel,
      code: expanded.code,
      declared_queries: expanded.declared_queries as typeof panel.declared_queries,
      declared_writes: expanded.declared_writes,
    };
  });
  store.commit({
    intent: "first run",
    summary: isBlank ? "Starts a blank canvas." : `Creates your ${bundle.shellName} views.`,
    semanticOrigin: "seed",
    migration: null,
    panels,
    diff: isBlank ? [] : [{ kind: "add_panel", detail: `${bundle.shellName} starter panels` }],
  });

  // Sample rows, flagged for one-click removal.
  const sampleIds: Record<string, string[]> = {};
  for (const table of bundle.tables) {
    sampleIds[table.name] = table.sampleRows.map(row =>
      String(store.insert(table.name, materializeSampleRow(table, row, seedInstant)).id));
  }
  store.setSetting("sample_rows", { format: 1, tables: sampleIds });
  store.setSetting("shell_id", bundle.shellId);
}

function sampleMarkerTables(value: unknown): Record<string, string[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const candidate = record.format === 1 ? record.tables : record;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return {};
  const tables: Record<string, string[]> = {};
  for (const [table, ids] of Object.entries(candidate)) {
    if (Array.isArray(ids) && ids.every(id => typeof id === "string")) tables[table] = [...ids];
  }
  return tables;
}

/** One-click sample removal (G9): kernel-local, soft-deleted (reversible). */
export function removeSampleRows(store: ClayStore): void {
  const marker = sampleMarkerTables(store.getSetting<unknown>("sample_rows"));
  for (const [table, ids] of Object.entries(marker))
    for (const id of ids) store.softDelete(table, id);
  store.setSetting("sample_rows", { format: 1, tables: {} });
}
