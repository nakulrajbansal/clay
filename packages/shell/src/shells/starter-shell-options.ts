// Presentation-only starter metadata. Keep the full seed tables and panels in
// the database worker graph instead of pulling them into the browser boot path.
export const STARTER_SHELL_OPTIONS = [
  {
    id: "blank",
    name: "Blank canvas",
    tagline: "Start from nothing — describe the app you want and watch it build itself.",
  },
  { id: "tracker", name: "Tracker", tagline: "Projects, tasks, anything with a status" },
  { id: "log", name: "Log", tagline: "Entries over time: reading, workouts, anything" },
  { id: "dashboard", name: "Dashboard", tagline: "Records plus the numbers that matter" },
  {
    id: "small_business",
    name: "Small Business",
    tagline: "Customers, jobs, invoices, money — your whole business in one app",
  },
  {
    id: "crm",
    name: "Sales CRM",
    tagline: "Contacts, companies, and a deal pipeline (like HubSpot or Pipedrive)",
  },
  {
    id: "financials",
    name: "Bookkeeping",
    tagline: "Accounts, income and expenses, invoices and bills (like QuickBooks or Wave)",
  },
  {
    id: "staff",
    name: "Staff & Scheduling",
    tagline: "Employees, shifts, and time-off (like Deputy or When I Work)",
  },
  { id: "habits", name: "Habits", tagline: "Daily habits with streaks (like Streaks or Habitica)" },
  { id: "inventory", name: "Inventory", tagline: "Products, stock levels, and reorder alerts" },
  {
    id: "approvals",
    name: "Approvals",
    tagline: "Requests that flow through review, approval, and payment",
  },
  {
    id: "jobs",
    name: "Job Applications",
    tagline: "Track applications from saved to offer, with every move logged",
  },
  {
    id: "content",
    name: "Content Calendar",
    tagline: "Ideas to published: a pipeline plus a publish-date timeline",
  },
  {
    id: "okrs",
    name: "Goals & OKRs",
    tagline: "Objectives with measurable key results and visual progress",
  },
  {
    id: "events",
    name: "Event Planner",
    tagline: "Sessions on a calendar, by status, and in one table",
  },
  {
    id: "library",
    name: "Book Library",
    tagline: "A searchable shelf with a reading workflow and ratings",
  },
] as const;

export type StarterShellOption = (typeof STARTER_SHELL_OPTIONS)[number];
export type StarterShellOptionId = StarterShellOption["id"];
