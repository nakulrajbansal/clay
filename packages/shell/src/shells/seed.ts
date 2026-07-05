// First-run seeding (G9): static registries + hand-written panels + sample
// rows flagged for one-click removal. Zero network — US-01's promise.
//
// Templates are MULTI-TABLE (a small-business app has customers, jobs,
// invoices, …). One dataset, many views: several panels render the same
// tables in different ways (a jobs board AND a jobs table AND a dashboard
// count). Tables are created in commits of <=3 (invariant I5); panels then
// land in one commit; then sample rows.
import { ClayStore, deriveInverse, type MigrationPlanT } from "@clay/kernel";
import { SEED_PANELS } from "./seed-panels";

export type StarterShellId = "tracker" | "log" | "dashboard" | "small_business";

export type ShellColumn = {
  name: string;
  type: "text" | "number" | "integer" | "date" | "enum";
  required: boolean;
  values?: string[];
};
export type ShellTable = {
  name: string;
  columns: ShellColumn[];
  sampleRows: Record<string, unknown>[];
};
export type StarterShell = {
  id: StarterShellId;
  name: string;
  tagline: string;
  tables: ShellTable[];
};

const col = (name: string, type: ShellColumn["type"],
  required = false, values?: string[]): ShellColumn =>
  ({ name, type, required, ...(values ? { values } : {}) });

export const STARTER_SHELLS: StarterShell[] = [
  {
    id: "tracker", name: "Tracker",
    tagline: "Projects, tasks, anything with a status",
    tables: [{
      name: "items",
      columns: [
        col("name", "text", true), col("owner", "text"),
        col("status", "enum", false, ["todo", "doing", "done"]),
        col("due", "date"), col("notes", "text"),
      ],
      sampleRows: [
        { name: "Ship the deck", owner: "You", status: "doing", due: "2026-07-10" },
        { name: "Book dentist", owner: "You", status: "todo", due: "2026-07-20" },
        { name: "Water plants", owner: "You", status: "done", due: "2026-07-01" },
      ],
    }],
  },
  {
    id: "log", name: "Log",
    tagline: "Entries over time: reading, workouts, anything",
    tables: [{
      name: "entries",
      columns: [
        col("title", "text", true), col("on", "date", true),
        col("amount", "number"), col("rating", "integer"), col("notes", "text"),
      ],
      sampleRows: [
        { title: "Morning run", on: "2026-06-29", amount: 5, rating: 4 },
        { title: "Read: The Overstory", on: "2026-06-30", amount: 40, rating: 5 },
        { title: "Swim", on: "2026-07-01", amount: 1, rating: 3 },
      ],
    }],
  },
  {
    id: "dashboard", name: "Dashboard",
    tagline: "Records plus the numbers that matter",
    tables: [{
      name: "records",
      columns: [
        col("name", "text", true),
        col("category", "enum", false, ["a", "b", "c"]),
        col("value", "number"), col("on", "date"),
      ],
      sampleRows: [
        { name: "Website refresh", category: "a", value: 1200, on: "2026-06-05" },
        { name: "Logo pack", category: "b", value: 450, on: "2026-06-12" },
        { name: "Brand audit", category: "a", value: 900, on: "2026-06-18" },
        { name: "Social kit", category: "c", value: 300, on: "2026-06-25" },
        { name: "Retainer", category: "b", value: 2000, on: "2026-07-01" },
      ],
    }],
  },
  {
    id: "small_business", name: "Small Business",
    tagline: "Customers, jobs, invoices, money — your whole business in one app",
    tables: [
      {
        name: "customers",
        columns: [
          col("name", "text", true), col("phone", "text"), col("email", "text"),
          col("address", "text"), col("notes", "text"),
        ],
        sampleRows: [
          { name: "Alice Nguyen", phone: "555-0110", email: "alice@example.com", address: "12 Oak St" },
          { name: "Bob's Cafe", phone: "555-0143", email: "bob@bobscafe.com", address: "44 Main St" },
          { name: "Carla Reyes", phone: "555-0177", email: "carla@example.com", address: "9 Pine Ave" },
        ],
      },
      {
        name: "jobs",
        columns: [
          col("title", "text", true), col("customer", "text"),
          col("status", "enum", false, ["lead", "scheduled", "in_progress", "done", "invoiced"]),
          col("scheduled", "date"), col("price", "number"), col("notes", "text"),
        ],
        sampleRows: [
          { title: "Kitchen faucet fix", customer: "Alice Nguyen", status: "scheduled", scheduled: "2026-07-06", price: 180 },
          { title: "Espresso machine service", customer: "Bob's Cafe", status: "in_progress", scheduled: "2026-07-04", price: 420 },
          { title: "Bathroom remodel quote", customer: "Carla Reyes", status: "lead", scheduled: "2026-07-09", price: 0 },
          { title: "Water heater install", customer: "Alice Nguyen", status: "done", scheduled: "2026-06-28", price: 950 },
          { title: "Drain cleaning", customer: "Bob's Cafe", status: "invoiced", scheduled: "2026-06-20", price: 140 },
        ],
      },
      {
        name: "invoices",
        columns: [
          col("customer", "text"), col("job", "text"), col("amount", "number"),
          col("status", "enum", false, ["draft", "sent", "paid"]),
          col("issued", "date"), col("due", "date"),
        ],
        sampleRows: [
          { customer: "Bob's Cafe", job: "Drain cleaning", amount: 140, status: "paid", issued: "2026-06-21", due: "2026-07-05" },
          { customer: "Alice Nguyen", job: "Water heater install", amount: 950, status: "sent", issued: "2026-06-29", due: "2026-07-13" },
          { customer: "Bob's Cafe", job: "Espresso machine service", amount: 420, status: "draft", issued: "2026-07-04", due: "2026-07-18" },
        ],
      },
      {
        name: "items",
        columns: [
          col("name", "text", true), col("price", "number"),
          col("category", "enum", false, ["service", "product", "material"]),
        ],
        sampleRows: [
          { name: "Standard callout", price: 90, category: "service" },
          { name: "Replacement faucet", price: 65, category: "product" },
          { name: "Copper pipe (per m)", price: 12, category: "material" },
        ],
      },
      {
        name: "expenses",
        columns: [
          col("description", "text", true), col("amount", "number"),
          col("category", "enum", false, ["supplies", "fuel", "tools", "other"]),
          col("on", "date"),
        ],
        sampleRows: [
          { description: "Van fuel", amount: 60, category: "fuel", on: "2026-07-01" },
          { description: "Pipe stock", amount: 210, category: "supplies", on: "2026-06-30" },
        ],
      },
    ],
  },
];

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function seedStarterShell(store: ClayStore, id: StarterShellId): void {
  const shell = STARTER_SHELLS.find(s => s.id === id);
  if (!shell) throw new Error(`unknown starter shell '${id}'`);

  // Tables in commits of <=3 (invariant I5). Multi-table templates take
  // more than one commit; that is fine — they land before any panel.
  for (const group of chunk(shell.tables, 3)) {
    const operations: MigrationPlanT["operations"] = group.map(t => ({
      op: "create_table", table: t.name,
      columns: t.columns.map(c => ({
        name: c.name, type: c.type, required: c.required,
        ...(c.values ? { values: c.values } : {}),
      })),
    }));
    store.commit({
      intent: "first run", summary: `Sets up ${group.map(t => t.name).join(", ")}.`,
      migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
    });
  }

  // All panels in one commit.
  store.commit({
    intent: "first run", summary: `Creates your ${shell.name} views.`,
    migration: null, panels: SEED_PANELS[shell.id]!,
    diff: [{ kind: "add_panel", detail: `${shell.name} starter panels` }],
  });

  // Sample rows, flagged for one-click removal.
  const sampleIds: Record<string, string[]> = {};
  for (const t of shell.tables) {
    sampleIds[t.name] = t.sampleRows.map(row => String(store.insert(t.name, row).id));
  }
  store.setSetting("sample_rows", sampleIds);
  store.setSetting("shell_id", shell.id);
}

/** One-click sample removal (G9): kernel-local, soft-deleted (reversible). */
export function removeSampleRows(store: ClayStore): void {
  const marker = store.getSetting<Record<string, string[]>>("sample_rows") ?? {};
  for (const [table, ids] of Object.entries(marker))
    for (const id of ids) store.softDelete(table, id);
  store.setSetting("sample_rows", {});
}
