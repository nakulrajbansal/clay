// First-run seeding (G9): static registries + hand-written panels + sample
// rows flagged for one-click removal. Zero network — US-01's 60-second
// promise. The registry/id/placement data here is a typed copy of
// specs/shells/starter-shells.json; a drift test keeps them identical.
import { ClayStore, deriveInverse, type MigrationPlanT } from "@clay/kernel";
import { SEED_PANELS } from "./seed-panels";

export type StarterShellId = "tracker" | "log" | "dashboard";

type ShellColumn = {
  name: string;
  type: "text" | "number" | "integer" | "date" | "enum";
  required: boolean;
  values?: string[];
};

export type StarterShell = {
  id: StarterShellId;
  name: string;
  tagline: string;
  table: string;
  columns: ShellColumn[];
  sampleRows: Record<string, unknown>[];
};

export const STARTER_SHELLS: StarterShell[] = [
  {
    id: "tracker", name: "Tracker",
    tagline: "Projects, tasks, anything with a status",
    table: "items",
    columns: [
      { name: "name", type: "text", required: true },
      { name: "owner", type: "text", required: false },
      { name: "status", type: "enum", required: false, values: ["todo", "doing", "done"] },
      { name: "due", type: "date", required: false },
      { name: "notes", type: "text", required: false },
    ],
    sampleRows: [
      { name: "Ship the deck", owner: "You", status: "doing", due: "2026-07-10" },
      { name: "Book dentist", owner: "You", status: "todo", due: "2026-07-20" },
      { name: "Water plants", owner: "You", status: "done", due: "2026-07-01" },
    ],
  },
  {
    id: "log", name: "Log",
    tagline: "Entries over time: reading, workouts, anything",
    table: "entries",
    columns: [
      { name: "title", type: "text", required: true },
      { name: "on", type: "date", required: true },
      { name: "amount", type: "number", required: false },
      { name: "rating", type: "integer", required: false },
      { name: "notes", type: "text", required: false },
    ],
    sampleRows: [
      { title: "Morning run", on: "2026-06-29", amount: 5, rating: 4 },
      { title: "Read: The Overstory", on: "2026-06-30", amount: 40, rating: 5 },
      { title: "Swim", on: "2026-07-01", amount: 1, rating: 3 },
    ],
  },
  {
    id: "dashboard", name: "Dashboard",
    tagline: "Records plus the numbers that matter",
    table: "records",
    columns: [
      { name: "name", type: "text", required: true },
      { name: "category", type: "enum", required: false, values: ["a", "b", "c"] },
      { name: "value", type: "number", required: false },
      { name: "on", type: "date", required: false },
    ],
    sampleRows: [
      { name: "Website refresh", category: "a", value: 1200, on: "2026-06-05" },
      { name: "Logo pack", category: "b", value: 450, on: "2026-06-12" },
      { name: "Brand audit", category: "a", value: 900, on: "2026-06-18" },
      { name: "Social kit", category: "c", value: 300, on: "2026-06-25" },
      { name: "Retainer", category: "b", value: 2000, on: "2026-07-01" },
    ],
  },
];

export function seedStarterShell(store: ClayStore, id: StarterShellId): void {
  const shell = STARTER_SHELLS.find(s => s.id === id);
  if (!shell) throw new Error(`unknown starter shell '${id}'`);
  const operations: MigrationPlanT["operations"] = [{
    op: "create_table", table: shell.table, columns: shell.columns,
  }];
  store.commit({
    intent: "first run",
    summary: `Creates your ${shell.name} starter shell.`,
    migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
    panels: SEED_PANELS[shell.id]!,
    diff: [{ kind: "add_panel", detail: `${shell.name} starter panels` }],
  });
  const sampleIds: string[] = [];
  for (const row of shell.sampleRows)
    sampleIds.push(String(store.insert(shell.table, row).id));
  store.setSetting("sample_rows", { [shell.table]: sampleIds });
  store.setSetting("shell_id", shell.id);
}

/** One-click sample removal (G9): kernel-local, soft-deleted (reversible). */
export function removeSampleRows(store: ClayStore): void {
  const marker = store.getSetting<Record<string, string[]>>("sample_rows") ?? {};
  for (const [table, ids] of Object.entries(marker))
    for (const id of ids) store.softDelete(table, id);
  store.setSetting("sample_rows", {});
}
