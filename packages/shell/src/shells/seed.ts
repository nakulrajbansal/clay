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

export type StarterShellId =
  | "blank"
  | "tracker" | "log" | "dashboard" | "small_business"
  | "crm" | "financials" | "staff";

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

// Sample dates relative to seed time, so "upcoming / next N days" panels are
// populated on first run whenever the app is opened (not stale fixed dates).
const soon = (offsetDays: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

export const STARTER_SHELLS: StarterShell[] = [
  {
    id: "blank", name: "Blank canvas",
    tagline: "Start from nothing — describe the app you want and watch it build itself.",
    tables: [],
  },
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
        { name: "Ship the deck", owner: "You", status: "doing", due: soon(3) },
        { name: "Book dentist", owner: "You", status: "todo", due: soon(12) },
        { name: "Water plants", owner: "You", status: "done", due: soon(-5) },
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
        { title: "Morning run", on: soon(-2), amount: 5, rating: 4 },
        { title: "Read: The Overstory", on: soon(-4), amount: 40, rating: 5 },
        { title: "Swim", on: soon(-8), amount: 1, rating: 3 },
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
        { name: "Website refresh", category: "a", value: 1200, on: soon(-40) },
        { name: "Logo pack", category: "b", value: 450, on: soon(-33) },
        { name: "Brand audit", category: "a", value: 900, on: soon(-20) },
        { name: "Social kit", category: "c", value: 300, on: soon(-8) },
        { name: "Retainer", category: "b", value: 2000, on: soon(-2) },
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
          { title: "Kitchen faucet fix", customer: "Alice Nguyen", status: "scheduled", scheduled: soon(2), price: 180 },
          { title: "Espresso machine service", customer: "Bob's Cafe", status: "in_progress", scheduled: soon(5), price: 420 },
          { title: "Bathroom remodel quote", customer: "Carla Reyes", status: "lead", scheduled: soon(9), price: 0 },
          { title: "Water heater install", customer: "Alice Nguyen", status: "done", scheduled: soon(-6), price: 950 },
          { title: "Drain cleaning", customer: "Bob's Cafe", status: "invoiced", scheduled: soon(-14), price: 140 },
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
          { customer: "Bob's Cafe", job: "Drain cleaning", amount: 140, status: "paid", issued: soon(-14), due: soon(-4) },
          { customer: "Alice Nguyen", job: "Water heater install", amount: 950, status: "sent", issued: soon(-6), due: soon(6) },
          { customer: "Bob's Cafe", job: "Espresso machine service", amount: 420, status: "draft", issued: soon(-2), due: soon(12) },
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
          { description: "Van fuel", amount: 60, category: "fuel", on: soon(-5) },
          { description: "Pipe stock", amount: 210, category: "supplies", on: soon(-8) },
        ],
      },
    ],
  },
  {
    id: "crm", name: "Sales CRM",
    tagline: "Contacts, companies, and a deal pipeline (like HubSpot or Pipedrive)",
    tables: [
      {
        name: "contacts",
        columns: [
          col("name", "text", true), col("email", "text"), col("phone", "text"),
          col("company", "text"), col("title", "text"),
        ],
        sampleRows: [
          { name: "Dana Lee", email: "dana@northwind.co", phone: "555-0101", company: "Northwind", title: "Owner" },
          { name: "Sam Patel", email: "sam@brightlab.io", phone: "555-0102", company: "BrightLab", title: "Ops" },
          { name: "Rosa Diaz", email: "rosa@harborcafe.com", phone: "555-0103", company: "Harbor Cafe", title: "Manager" },
        ],
      },
      {
        name: "companies",
        columns: [
          col("name", "text", true), col("industry", "text"), col("website", "text"),
          col("size", "enum", false, ["small", "medium", "large"]),
        ],
        sampleRows: [
          { name: "Northwind", industry: "Retail", website: "northwind.co", size: "small" },
          { name: "BrightLab", industry: "Software", website: "brightlab.io", size: "medium" },
        ],
      },
      {
        name: "deals",
        columns: [
          col("title", "text", true), col("contact", "text"), col("company", "text"),
          col("stage", "enum", false, ["lead", "qualified", "proposal", "negotiation", "won", "lost"]),
          col("value", "number"), col("owner", "text"),
          col("source", "enum", false, ["inbound", "outbound", "referral", "event"]),
          col("probability", "integer"), col("expected_close", "date"),
        ],
        sampleRows: [
          { title: "Northwind annual plan", contact: "Dana Lee", company: "Northwind", stage: "proposal", value: 8000, owner: "You", source: "inbound", probability: 60, expected_close: soon(9) },
          { title: "BrightLab pilot", contact: "Sam Patel", company: "BrightLab", stage: "qualified", value: 3500, owner: "You", source: "outbound", probability: 40, expected_close: soon(20) },
          { title: "BrightLab expansion", contact: "Sam Patel", company: "BrightLab", stage: "negotiation", value: 12000, owner: "You", source: "referral", probability: 80, expected_close: soon(4) },
          { title: "Harbor Cafe setup", contact: "Rosa Diaz", company: "Harbor Cafe", stage: "won", value: 1200, owner: "You", source: "referral", probability: 100, expected_close: soon(-16) },
          { title: "Referral lead", contact: "Sam Patel", company: "BrightLab", stage: "lead", value: 0, owner: "You", source: "referral", probability: 10, expected_close: soon(30) },
        ],
      },
      {
        name: "activities",
        columns: [
          col("subject", "text", true), col("contact", "text"), col("deal", "text"),
          col("type", "enum", false, ["call", "email", "meeting", "note"]),
          col("on", "date"),
        ],
        sampleRows: [
          { subject: "Discovery call", contact: "Dana Lee", deal: "Northwind annual plan", type: "call", on: soon(-8) },
          { subject: "Sent proposal", contact: "Dana Lee", deal: "Northwind annual plan", type: "email", on: soon(-7) },
          { subject: "Kickoff", contact: "Rosa Diaz", deal: "Harbor Cafe setup", type: "meeting", on: soon(-12) },
        ],
      },
      {
        name: "tasks",
        columns: [
          col("title", "text", true), col("deal", "text"), col("owner", "text"),
          col("due", "date"),
          col("priority", "enum", false, ["low", "medium", "high"]),
          col("status", "enum", false, ["open", "done"]),
        ],
        sampleRows: [
          { title: "Follow up on proposal", deal: "Northwind annual plan", owner: "You", due: soon(1), priority: "high", status: "open" },
          { title: "Send pilot scope", deal: "BrightLab pilot", owner: "You", due: soon(3), priority: "medium", status: "open" },
          { title: "Contract review", deal: "BrightLab expansion", owner: "You", due: soon(6), priority: "high", status: "open" },
          { title: "Thank-you note", deal: "Harbor Cafe setup", owner: "You", due: soon(-9), priority: "low", status: "done" },
        ],
      },
    ],
  },
  {
    id: "financials", name: "Bookkeeping",
    tagline: "Accounts, income and expenses, invoices and bills (like QuickBooks or Wave)",
    tables: [
      {
        name: "accounts",
        columns: [
          col("name", "text", true),
          col("type", "enum", false, ["checking", "savings", "credit", "cash"]),
          col("balance", "number"),
        ],
        sampleRows: [
          { name: "Business checking", type: "checking", balance: 8400 },
          { name: "Business card", type: "credit", balance: -1200 },
        ],
      },
      {
        name: "transactions",
        columns: [
          col("description", "text", true), col("account", "text"), col("amount", "number"),
          col("kind", "enum", false, ["income", "expense"]),
          col("category", "text"), col("on", "date"),
        ],
        sampleRows: [
          { description: "Client payment — Northwind", account: "Business checking", amount: 1200, kind: "income", category: "Sales", on: soon(-9) },
          { description: "Software subscription", account: "Business card", amount: 90, kind: "expense", category: "Software", on: soon(-6) },
          { description: "Supplies", account: "Business card", amount: 210, kind: "expense", category: "Materials", on: soon(-7) },
          { description: "Client payment — Harbor", account: "Business checking", amount: 1200, kind: "income", category: "Sales", on: soon(-3) },
        ],
      },
      {
        name: "invoices",
        columns: [
          col("customer", "text"), col("amount", "number"),
          col("status", "enum", false, ["draft", "sent", "paid", "overdue"]),
          col("issued", "date"), col("due", "date"),
        ],
        sampleRows: [
          { customer: "Northwind", amount: 8000, status: "sent", issued: soon(-6), due: soon(8) },
          { customer: "BrightLab", amount: 3500, status: "draft", issued: soon(-1), due: soon(14) },
          { customer: "Harbor Cafe", amount: 1200, status: "paid", issued: soon(-14), due: soon(-2) },
        ],
      },
      {
        name: "bills",
        columns: [
          col("vendor", "text", true), col("amount", "number"),
          col("status", "enum", false, ["unpaid", "paid"]), col("due", "date"),
        ],
        sampleRows: [
          { vendor: "Supply Co", amount: 210, status: "unpaid", due: soon(4) },
          { vendor: "Cloud Host", amount: 90, status: "paid", due: soon(-13) },
        ],
      },
    ],
  },
  {
    id: "staff", name: "Staff & Scheduling",
    tagline: "Employees, shifts, and time-off (like Deputy or When I Work)",
    tables: [
      {
        name: "employees",
        columns: [
          col("name", "text", true), col("role", "text"), col("phone", "text"),
          col("email", "text"),
          col("status", "enum", false, ["active", "on_leave", "inactive"]),
        ],
        sampleRows: [
          { name: "Maya Chen", role: "Barista", phone: "555-0201", email: "maya@x.com", status: "active" },
          { name: "Leo Park", role: "Shift lead", phone: "555-0202", email: "leo@x.com", status: "active" },
          { name: "Ivy Ross", role: "Barista", phone: "555-0203", email: "ivy@x.com", status: "on_leave" },
        ],
      },
      {
        name: "shifts",
        columns: [
          col("employee", "text"), col("date", "date", true),
          col("start_time", "text"), col("end_time", "text"), col("role", "text"),
          col("status", "enum", false, ["scheduled", "confirmed", "completed"]),
        ],
        sampleRows: [
          { employee: "Maya Chen", date: soon(1), start_time: "08:00", end_time: "14:00", role: "Barista", status: "confirmed" },
          { employee: "Leo Park", date: soon(2), start_time: "13:00", end_time: "21:00", role: "Shift lead", status: "scheduled" },
          { employee: "Maya Chen", date: soon(4), start_time: "08:00", end_time: "14:00", role: "Barista", status: "scheduled" },
        ],
      },
      {
        name: "time_off",
        columns: [
          col("employee", "text"),
          col("kind", "enum", false, ["vacation", "sick", "personal"]),
          col("start_date", "date"), col("end_date", "date"),
          col("status", "enum", false, ["pending", "approved", "denied"]),
        ],
        sampleRows: [
          { employee: "Ivy Ross", kind: "vacation", start_date: soon(3), end_date: soon(10), status: "approved" },
          { employee: "Leo Park", kind: "personal", start_date: soon(6), end_date: soon(6), status: "pending" },
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

  // All panels in one commit (a blank canvas commits an empty first version
  // so the app is "started" but carries nothing to reshape from).
  const isBlank = shell.tables.length === 0;
  store.commit({
    intent: "first run",
    summary: isBlank ? "Starts a blank canvas." : `Creates your ${shell.name} views.`,
    migration: null, panels: SEED_PANELS[shell.id] ?? [],
    diff: isBlank ? [] : [{ kind: "add_panel", detail: `${shell.name} starter panels` }],
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
