// Canned archetype stores for the regression suite (doc 08 §4). Each is a
// real ClayStore seeded to match specs/exemplars/00-contexts.md, so the
// suite runs S2->S3->S4 through the actual MutationPipeline.
import { ClayStore, deriveInverse, type MigrationPlanT } from "@clay/kernel";

type Col = { name: string; type: "text" | "number" | "integer" | "date" | "enum";
  required?: boolean; values?: string[] };

async function build(
  tables: { table: string; columns: Col[] }[],
  panels: { id: string; title: string; region: "top" | "main" | "side";
    order: number; from: string; writes?: string[] }[],
): Promise<ClayStore> {
  const store = await ClayStore.openMemory();
  const operations: MigrationPlanT["operations"] = tables.map(t => ({
    op: "create_table", table: t.table,
    columns: t.columns.map(c => ({
      name: c.name, type: c.type, required: c.required ?? false,
      ...(c.values ? { values: c.values } : {}),
    })),
  }));
  store.commit({
    intent: "seed", summary: "Sets up the app.",
    migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
    panels: panels.map(p => ({
      panel_id: p.id, title: p.title,
      placement: { region: p.region, order: p.order },
      code: `export default function (clay) {
  clay.db.watch({ from: ${JSON.stringify(p.from)} }, (rows) => {
    clay.ui.render(h(Table, { rows, columns: [{ field: "id", label: "id" }] }));
  });
}`,
      declared_queries: [{ from: p.from }],
      declared_writes: p.writes ?? [],
    })),
  });
  return store;
}

export function groomStore(): Promise<ClayStore> {
  return build(
    [
      { table: "clients", columns: [
        { name: "name", type: "text", required: true },
        { name: "phone", type: "text" }, { name: "dog_name", type: "text" },
        { name: "breed", type: "text" }, { name: "last_visit", type: "date" },
        { name: "notes", type: "text" }] },
      { table: "appointments", columns: [
        { name: "client_id", type: "text", required: true },
        { name: "at", type: "date", required: true },
        { name: "service", type: "enum", values: ["bath", "full_groom", "nails"] },
        { name: "price", type: "number" },
        { name: "status", type: "enum", values: ["booked", "done", "no_show"] }] },
    ],
    [
      { id: "client_list", title: "Clients", region: "main", order: 0, from: "clients" },
      { id: "upcoming", title: "Upcoming", region: "top", order: 0, from: "appointments" },
    ]);
}

export function trackStore(): Promise<ClayStore> {
  return build(
    [{ table: "projects", columns: [
      { name: "name", type: "text", required: true },
      { name: "owner", type: "text" },
      { name: "status", type: "enum", values: ["green", "amber", "red"] },
      { name: "next_milestone", type: "date" },
      { name: "slipped_milestones", type: "integer" },
      { name: "open_risks", type: "integer" }] }],
    [
      { id: "project_table", title: "Projects", region: "main", order: 0, from: "projects" },
      { id: "status_counts", title: "Status", region: "top", order: 0, from: "projects" },
    ]);
}

export function logStore(): Promise<ClayStore> {
  return build(
    [{ table: "books", columns: [
      { name: "title", type: "text", required: true },
      { name: "author", type: "text" }, { name: "pages", type: "integer" },
      { name: "started", type: "date" }, { name: "finished", type: "date" },
      { name: "rating", type: "integer" }] }],
    [{ id: "book_list", title: "Books", region: "main", order: 0, from: "books" }]);
}

export type Archetype = "A" | "B" | "C";
export const ARCHETYPE_STORES: Record<Archetype, () => Promise<ClayStore>> = {
  A: groomStore, B: trackStore, C: logStore,
};
