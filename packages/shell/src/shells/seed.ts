// First-run seeding (G9): static registries + hand-written panels + sample
// rows flagged for one-click removal. Zero network — US-01's promise.
//
// Templates are MULTI-TABLE (a small-business app has customers, jobs,
// invoices, …). One dataset, many views: several panels render the same
// tables in different ways (a jobs board AND a jobs table AND a dashboard
// count). Tables are created in commits of <=3 (invariant I5); panels then
// land in one commit; then sample rows.
import {
  ClayStore, deriveInverse, expandBlueprint, parseBlueprintDirective,
  type MigrationPlanT,
} from "@clay/kernel";
import { SEED_PANELS } from "./seed-panels";

export type StarterShellId =
  | "blank"
  | "tracker" | "log" | "dashboard" | "small_business"
  | "crm" | "financials" | "staff" | "habits" | "inventory" | "approvals"
  | "jobs" | "content" | "okrs" | "events" | "library";

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
  {
    id: "habits", name: "Habits",
    tagline: "Daily habits with streaks (like Streaks or Habitica)",
    tables: [
      {
        name: "habits",
        columns: [
          col("name", "text", true),
          col("category", "enum", false, ["health", "mind", "work", "social"]),
          col("streak", "number"), col("best", "number"),
          col("last_done", "date"), col("notes", "text"),
        ],
        sampleRows: [
          { name: "Morning run", category: "health", streak: 12, best: 20, last_done: soon(0) },
          { name: "Read 20 min", category: "mind", streak: 5, best: 14, last_done: soon(-1) },
          { name: "Inbox to zero", category: "work", streak: 3, best: 9, last_done: soon(0) },
          { name: "Call a friend", category: "social", streak: 0, best: 6, last_done: soon(-4) },
          { name: "Meditate", category: "mind", streak: 8, best: 8, last_done: soon(0) },
          { name: "Meal prep", category: "health", streak: 2, best: 5, last_done: soon(-2) },
        ],
      },
    ],
  },
  {
    id: "inventory", name: "Inventory",
    tagline: "Products, stock levels, and reorder alerts",
    tables: [
      {
        name: "products",
        columns: [
          col("name", "text", true), col("sku", "text"),
          col("category", "enum", false, ["retail", "food", "supplies", "other"]),
          col("price", "number"), col("stock", "number"), col("reorder_at", "number"),
        ],
        sampleRows: [
          { name: "House blend beans 1kg", sku: "COF-001", category: "food", price: 18, stock: 4, reorder_at: 6 },
          { name: "Oat milk carton", sku: "MLK-002", category: "food", price: 3, stock: 24, reorder_at: 12 },
          { name: "Ceramic mug", sku: "MUG-010", category: "retail", price: 14, stock: 2, reorder_at: 5 },
          { name: "Paper cups (sleeve)", sku: "CUP-050", category: "supplies", price: 6, stock: 40, reorder_at: 15 },
          { name: "Tote bag", sku: "BAG-003", category: "retail", price: 22, stock: 9, reorder_at: 4 },
          { name: "Cleaning spray", sku: "CLN-007", category: "supplies", price: 5, stock: 1, reorder_at: 3 },
        ],
      },
    ],
  },
  {
    id: "approvals", name: "Approvals",
    tagline: "Requests that flow through review, approval, and payment",
    tables: [
      {
        name: "requests",
        columns: [
          col("title", "text", true), col("requester", "text"),
          col("category", "enum", false, ["equipment", "travel", "software", "other"]),
          col("amount", "number"),
          col("stage", "enum", false, ["submitted", "in_review", "approved", "paid"]),
          col("decision_note", "text"), col("submitted_on", "date"),
        ],
        sampleRows: [
          { title: "Standing desk", requester: "Ava Patel", category: "equipment", amount: 640, stage: "submitted", decision_note: "", submitted_on: soon(-1) },
          { title: "Conference travel — DevConf", requester: "Liam Chen", category: "travel", amount: 1850, stage: "in_review", decision_note: "Waiting on flight quote", submitted_on: soon(-4) },
          { title: "Design tool licences (5)", requester: "Maya Rodriguez", category: "software", amount: 900, stage: "in_review", decision_note: "", submitted_on: soon(-3) },
          { title: "Team offsite venue deposit", requester: "Noah Kim", category: "other", amount: 1200, stage: "approved", decision_note: "Approved for Q3 budget", submitted_on: soon(-9) },
          { title: "Laptop replacement", requester: "Zoe Ahmed", category: "equipment", amount: 1400, stage: "paid", decision_note: "Paid 07/02", submitted_on: soon(-14) },
        ],
      },
      {
        name: "request_activity",
        columns: [
          col("request", "text", true), col("from_stage", "text"),
          col("to_stage", "text"), col("moved_on", "date"),
        ],
        sampleRows: [
          { request: "Laptop replacement", from_stage: "in_review", to_stage: "approved", moved_on: soon(-10) },
          { request: "Laptop replacement", from_stage: "approved", to_stage: "paid", moved_on: soon(-7) },
          { request: "Team offsite venue deposit", from_stage: "in_review", to_stage: "approved", moved_on: soon(-2) },
        ],
      },
    ],
  },
  {
    id: "jobs", name: "Job Applications",
    tagline: "Track applications from saved to offer, with every move logged",
    tables: [
      {
        name: "applications",
        columns: [
          col("company", "text", true), col("role", "text"),
          col("stage", "enum", false, ["saved", "applied", "interview", "offer", "closed"]),
          col("salary", "number"), col("location", "text"),
          col("applied_on", "date"), col("next_step", "text"),
        ],
        sampleRows: [
          { company: "Northwind", role: "Product Engineer", stage: "saved", salary: 145000, location: "Remote", next_step: "Tailor resume to posting" },
          { company: "BrightLab", role: "Frontend Engineer", stage: "applied", salary: 132000, location: "Austin", applied_on: soon(-6), next_step: "Follow up if quiet by Friday" },
          { company: "Globex", role: "Full-stack Developer", stage: "applied", salary: 128000, location: "Remote", applied_on: soon(-3), next_step: "" },
          { company: "Initech", role: "Senior SWE", stage: "interview", salary: 160000, location: "Toronto", applied_on: soon(-12), next_step: "Panel interview " + "on site" },
          { company: "Umbrella Labs", role: "Platform Engineer", stage: "offer", salary: 155000, location: "Remote", applied_on: soon(-21), next_step: "Negotiate start date" },
          { company: "Hooli", role: "Web Developer", stage: "closed", salary: 0, location: "Berlin", applied_on: soon(-30), next_step: "" },
        ],
      },
      {
        name: "app_activity",
        columns: [
          col("application", "text", true), col("from_stage", "text"),
          col("to_stage", "text"), col("moved_on", "date"),
        ],
        sampleRows: [
          { application: "Initech", from_stage: "applied", to_stage: "interview", moved_on: soon(-4) },
          { application: "Umbrella Labs", from_stage: "interview", to_stage: "offer", moved_on: soon(-2) },
          { application: "Hooli", from_stage: "applied", to_stage: "closed", moved_on: soon(-15) },
        ],
      },
    ],
  },
  {
    id: "content", name: "Content Calendar",
    tagline: "Ideas to published: a pipeline plus a publish-date timeline",
    tables: [
      {
        name: "posts",
        columns: [
          col("title", "text", true),
          col("channel", "enum", false, ["blog", "youtube", "newsletter", "social"]),
          col("stage", "enum", false, ["idea", "draft", "review", "scheduled", "published"]),
          col("publish_on", "date"), col("owner", "text"), col("notes", "text"),
        ],
        sampleRows: [
          { title: "How we cut onboarding time in half", channel: "blog", stage: "published", publish_on: soon(-5), owner: "Ava", notes: "" },
          { title: "Q3 product roadmap teaser", channel: "newsletter", stage: "scheduled", publish_on: soon(3), owner: "Liam", notes: "Waiting on final screenshots" },
          { title: "Customer story: Harbor Cafe", channel: "youtube", stage: "review", publish_on: soon(9), owner: "Maya", notes: "Legal sign-off pending" },
          { title: "5 workflow patterns that stick", channel: "blog", stage: "draft", publish_on: soon(14), owner: "Ava", notes: "" },
          { title: "Behind the scenes: support week", channel: "social", stage: "idea", publish_on: soon(21), owner: "Noah", notes: "" },
          { title: "Pricing page refresh announcement", channel: "newsletter", stage: "idea", publish_on: soon(28), owner: "Liam", notes: "" },
        ],
      },
    ],
  },
  {
    id: "okrs", name: "Goals & OKRs",
    tagline: "Objectives with measurable key results and visual progress",
    tables: [
      {
        name: "objectives",
        columns: [
          col("title", "text", true), col("owner", "text"),
          col("quarter", "enum", false, ["Q1", "Q2", "Q3", "Q4"]),
          col("status", "enum", false, ["draft", "active", "done"]),
        ],
        sampleRows: [
          { title: "Make onboarding effortless", owner: "Ava Patel", quarter: "Q3", status: "active" },
          { title: "Grow qualified pipeline", owner: "Liam Chen", quarter: "Q3", status: "active" },
          { title: "Harden the platform", owner: "Maya Rodriguez", quarter: "Q3", status: "draft" },
          { title: "Ship the mobile beta", owner: "Noah Kim", quarter: "Q2", status: "done" },
        ],
      },
      {
        name: "key_results",
        columns: [
          col("objective", "text", true), col("metric", "text"),
          col("target", "number"), col("current", "number"),
        ],
        sampleRows: [
          { objective: "Make onboarding effortless", metric: "Time to first value (min)", target: 10, current: 22 },
          { objective: "Make onboarding effortless", metric: "Setup completion %", target: 90, current: 61 },
          { objective: "Grow qualified pipeline", metric: "Qualified leads / mo", target: 120, current: 84 },
          { objective: "Grow qualified pipeline", metric: "Demo-to-close %", target: 25, current: 19 },
          { objective: "Harden the platform", metric: "p95 latency (ms)", target: 200, current: 340 },
          { objective: "Ship the mobile beta", metric: "Beta installs", target: 500, current: 512 },
        ],
      },
    ],
  },
  {
    id: "events", name: "Event Planner",
    tagline: "Sessions on a calendar, by status, and in one table",
    tables: [
      {
        name: "sessions",
        columns: [
          col("title", "text", true), col("speaker", "text"), col("room", "text"),
          col("day", "date"), col("start_time", "text"),
          col("status", "enum", false, ["proposed", "confirmed", "cancelled"]),
        ],
        sampleRows: [
          { title: "Opening keynote", speaker: "Ava Patel", room: "Main Hall", day: soon(6), start_time: "09:00", status: "confirmed" },
          { title: "Scaling with small teams", speaker: "Liam Chen", room: "Room A", day: soon(6), start_time: "11:00", status: "confirmed" },
          { title: "Design systems that last", speaker: "Maya Rodriguez", room: "Room B", day: soon(6), start_time: "14:00", status: "proposed" },
          { title: "The future of local-first", speaker: "Noah Kim", room: "Room A", day: soon(7), start_time: "10:00", status: "confirmed" },
          { title: "Panel: shipping weekly", speaker: "Zoe Ahmed", room: "Main Hall", day: soon(7), start_time: "13:00", status: "proposed" },
          { title: "Lightning talks", speaker: "Ethan Brooks", room: "Room B", day: soon(7), start_time: "15:00", status: "proposed" },
          { title: "Hands-on workshop", speaker: "Ines Fournier", room: "Lab", day: soon(6), start_time: "16:00", status: "cancelled" },
          { title: "Closing fireside chat", speaker: "Ravi Shah", room: "Main Hall", day: soon(7), start_time: "17:00", status: "confirmed" },
        ],
      },
    ],
  },
  {
    id: "library", name: "Book Library",
    tagline: "A searchable shelf with a reading workflow and ratings",
    tables: [
      {
        name: "books",
        columns: [
          col("title", "text", true), col("author", "text"),
          col("genre", "enum", false, ["fiction", "non_fiction", "sci_fi", "biography"]),
          col("status", "enum", false, ["to_read", "reading", "finished"]),
          col("rating", "integer"), col("finished_on", "date"),
        ],
        sampleRows: [
          { title: "The Silent Harbor", author: "M. Okafor", genre: "fiction", status: "finished", rating: 5, finished_on: soon(-20) },
          { title: "On Slow Thinking", author: "R. Feld", genre: "non_fiction", status: "reading", rating: 4 },
          { title: "Salt and Starlight", author: "J. Amara", genre: "sci_fi", status: "reading", rating: 4 },
          { title: "The Cartographer's Daughter", author: "L. Voss", genre: "fiction", status: "to_read", rating: 0 },
          { title: "A Field Guide to Rivers", author: "T. Brooks", genre: "non_fiction", status: "to_read", rating: 0 },
          { title: "Midnight at the Archive", author: "S. Kwon", genre: "sci_fi", status: "finished", rating: 3, finished_on: soon(-45) },
          { title: "The Last Lighthouse", author: "H. Mercer", genre: "biography", status: "to_read", rating: 0 },
          { title: "Notes from a Small Kitchen", author: "P. Andal", genre: "non_fiction", status: "finished", rating: 5, finished_on: soon(-8) },
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
  // Panels may be blueprint DIRECTIVES (ADR-029/030): expand them here
  // against the just-created registry — templates ride the same expansion
  // path model plans do, so the two can never drift.
  const isBlank = shell.tables.length === 0;
  const panels = (SEED_PANELS[shell.id] ?? []).map(p => {
    const spec = parseBlueprintDirective(p.code);
    if (spec === null) return p;
    const ex = expandBlueprint(spec, store.registrySnapshot());
    return { ...p, code: ex.code,
      declared_queries: ex.declared_queries as typeof p.declared_queries,
      declared_writes: ex.declared_writes };
  });
  store.commit({
    intent: "first run",
    summary: isBlank ? "Starts a blank canvas." : `Creates your ${shell.name} views.`,
    migration: null, panels,
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
