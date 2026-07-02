// Shared fixtures: the Context B-shaped registry and a seeded in-memory store.
import { ClayStore, type MigrationPlanT, type Registry } from "../src/index";

export function projectsRegistry(): Registry {
  return new Map([[
    "projects", {
      name: "projects",
      columns: [
        { name: "name", type: "text" as const, required: true },
        { name: "owner", type: "text" as const, required: false },
        { name: "status", type: "enum" as const, required: false, values: ["green", "amber", "red"] },
        { name: "next_milestone", type: "date" as const, required: false },
        { name: "slipped_milestones", type: "integer" as const, required: false },
        { name: "open_risks", type: "integer" as const, required: false },
      ],
    },
  ]]);
}

export const CREATE_PROJECTS: MigrationPlanT = {
  operations: [{
    op: "create_table", table: "projects",
    columns: [
      { name: "name", type: "text", required: true },
      { name: "owner", type: "text", required: false },
      { name: "status", type: "enum", required: false, values: ["green", "amber", "red"] },
      { name: "next_milestone", type: "date", required: false },
      { name: "slipped_milestones", type: "integer", required: false },
      { name: "open_risks", type: "integer", required: false },
    ],
  }],
  inverse: [{ op: "drop_table_if_created_by_this", table: "projects" }],
};

export async function seededStore(): Promise<ClayStore> {
  const store = await ClayStore.openMemory();
  store.commit({
    intent: "seed", summary: "Creates the projects table.",
    migration: CREATE_PROJECTS,
  });
  store.insert("projects", {
    name: "Apollo", owner: "Dev", status: "green",
    next_milestone: "2026-08-01", slipped_milestones: 0, open_risks: 1,
  });
  store.insert("projects", {
    name: "Borealis", owner: "Kim", status: "amber",
    next_milestone: "2026-07-10", slipped_milestones: 2, open_risks: 3,
  });
  store.insert("projects", {
    name: "Cygnus", owner: "Dev", status: "red",
    next_milestone: "2026-07-03", slipped_milestones: 4, open_risks: 5,
  });
  return store;
}

export const HEALTH_COMPUTED: MigrationPlanT = {
  operations: [{
    op: "create_computed", table: "projects", column: "health_score",
    expr: "100 - 10 * slipped_milestones - 5 * open_risks",
  }],
  inverse: [{ op: "drop_column_if_added_by_this", table: "projects", column: "health_score" }],
};
