import { STARTER_SHELL_CATALOG, type StarterShellId } from "../shells/starter-catalog";

export const STARTER_GOALS = [
  { id: "tasks", label: "Track tasks and projects", shellId: "tracker",
    rationale: "A flexible status tracker with ready-to-use views." },
  { id: "dated_entries", label: "Keep a dated log", shellId: "log",
    rationale: "A chronological log for entries, notes, and ratings." },
  { id: "metrics", label: "See key numbers", shellId: "dashboard",
    rationale: "A dashboard for records and the numbers that matter." },
  { id: "business", label: "Run customers and jobs", shellId: "small_business",
    rationale: "Customers, jobs, invoices, items, and expenses in one app." },
  { id: "sales", label: "Manage sales and deals", shellId: "crm",
    rationale: "Contacts, companies, follow-ups, and a deal pipeline." },
  { id: "money", label: "Track money", shellId: "financials",
    rationale: "Accounts, transactions, invoices, and bills." },
  { id: "staff", label: "Schedule staff", shellId: "staff",
    rationale: "Employees, shifts, and time-off in one place." },
  { id: "routines", label: "Build routines", shellId: "habits",
    rationale: "Daily habits with streaks and simple progress views." },
  { id: "stock", label: "Track stock", shellId: "inventory",
    rationale: "Products, stock levels, and reorder signals." },
  { id: "review", label: "Review requests", shellId: "approvals",
    rationale: "Requests moving through review, approval, and payment." },
  { id: "job_search", label: "Manage a job search", shellId: "jobs",
    rationale: "Applications, stages, next steps, and activity." },
  { id: "publishing", label: "Plan publishing", shellId: "content",
    rationale: "Ideas, drafts, reviews, and publish dates." },
  { id: "goals", label: "Track goals", shellId: "okrs",
    rationale: "Objectives and measurable results with progress." },
  { id: "events", label: "Plan events", shellId: "events",
    rationale: "Sessions, speakers, schedule, and event planning." },
  { id: "books", label: "Organize books", shellId: "library",
    rationale: "A reading library with status, ratings, and dates." },
] as const satisfies readonly {
  id: string; label: string; shellId: Exclude<StarterShellId, "blank">; rationale: string;
}[];

export type StarterGoalId = typeof STARTER_GOALS[number]["id"];
export const DEFAULT_STARTER_GOAL: StarterGoalId = "tasks";

export type StarterRecommendation = {
  goal: StarterGoalId;
  shellId: Exclude<StarterShellId, "blank">;
  name: string;
  tagline: string;
  rationale: string;
};

export function recommendStarter(goal: StarterGoalId): StarterRecommendation {
  const choice = STARTER_GOALS.find(candidate => candidate.id === goal);
  if (!choice) throw new Error("Unknown starter goal");
  const shell = STARTER_SHELL_CATALOG.find(candidate => candidate.id === choice.shellId);
  if (!shell || shell.id === "blank") throw new Error("Starter goal has no ready shell");
  return {
    goal: choice.id,
    shellId: choice.shellId,
    name: shell.name,
    tagline: shell.tagline,
    rationale: choice.rationale,
  };
}
