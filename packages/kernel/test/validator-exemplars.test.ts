// The exemplar gate: all ten hand-written exemplars run through the full
// Validator against their archetype contexts (specs/exemplars/00-contexts).
// 1–9 must pass clean; exemplar 10 must fail on exactly its planted V4
// violation (the undeclared clients query — see its NOTE).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateMutationPlan, type Registry } from "../src/index";

const exemplarsDir = fileURLToPath(new URL("../../../specs/exemplars/", import.meta.url));

function loadExemplar(file: string): unknown {
  const md = readFileSync(join(exemplarsDir, file), "utf8");
  const m = md.match(/```json\s*\n([\s\S]*?)```/);
  if (!m || !m[1]) throw new Error(`no json block in ${file}`);
  return JSON.parse(m[1]);
}

// Archetype contexts (specs/exemplars/00-contexts.md)
function contextA(): Registry {
  return new Map([
    ["clients", { name: "clients", columns: [
      { name: "name", type: "text" as const, required: true },
      { name: "phone", type: "text" as const, required: false },
      { name: "dog_name", type: "text" as const, required: false },
      { name: "breed", type: "text" as const, required: false },
      { name: "last_visit", type: "date" as const, required: false },
      { name: "notes", type: "text" as const, required: false },
    ] }],
    ["appointments", { name: "appointments", columns: [
      { name: "client_id", type: "text" as const, required: true },
      { name: "at", type: "date" as const, required: true },
      { name: "service", type: "enum" as const, required: false,
        values: ["bath", "full_groom", "nails"] },
      { name: "price", type: "number" as const, required: false },
      { name: "status", type: "enum" as const, required: false,
        values: ["booked", "done", "no_show"] },
    ] }],
  ]);
}
function contextB(): Registry {
  return new Map([["projects", { name: "projects", columns: [
    { name: "name", type: "text" as const, required: true },
    { name: "owner", type: "text" as const, required: false },
    { name: "status", type: "enum" as const, required: false,
      values: ["green", "amber", "red"] },
    { name: "next_milestone", type: "date" as const, required: false },
    { name: "slipped_milestones", type: "integer" as const, required: false },
    { name: "open_risks", type: "integer" as const, required: false },
  ] }]]);
}
function contextC(): Registry {
  return new Map([["books", { name: "books", columns: [
    { name: "title", type: "text" as const, required: true },
    { name: "author", type: "text" as const, required: false },
    { name: "pages", type: "integer" as const, required: false },
    { name: "started", type: "date" as const, required: false },
    { name: "finished", type: "date" as const, required: false },
    { name: "rating", type: "integer" as const, required: false },
  ] }]]);
}

const CONTEXTS: Record<string, { registry: () => Registry; livePanelIds: string[] }> = {
  A: { registry: contextA, livePanelIds: ["client_list", "upcoming"] },
  B: { registry: contextB, livePanelIds: ["project_table", "status_counts"] },
  C: { registry: contextC, livePanelIds: ["book_list"] },
};

const EXEMPLARS: [string, keyof typeof CONTEXTS][] = [
  ["01-add-field.md", "A"],
  ["02-enum-status.md", "B"],
  ["03-computed-and-strip.md", "B"],
  ["04-chart.md", "C"],
  ["05-form.md", "A"],
  ["06-filter-event-pair.md", "B"],
  ["07-clarify.md", "C"],
  ["08-rename.md", "B"],
  ["09-remove.md", "A"],
  ["11-board.md", "B"],
  ["12-cards.md", "A"],
];

describe("clean exemplars validate against their contexts", () => {
  for (const [file, ctxKey] of EXEMPLARS) {
    it(file, () => {
      const c = CONTEXTS[ctxKey]!;
      const issues = validateMutationPlan(loadExemplar(file), {
        registry: c.registry(), livePanelIds: c.livePanelIds,
      });
      expect(issues).toEqual([]);
    });
  }
});

describe("exemplar 10: the planted V4 fixture", () => {
  it("fails on exactly the undeclared clients query", () => {
    const c = CONTEXTS.A!;
    const issues = validateMutationPlan(loadExemplar("10-out-of-scope.md"), {
      registry: c.registry(), livePanelIds: c.livePanelIds,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ rule: "V4", panel: "tomorrow_reminders" });
    expect(issues[0]!.message).toContain("declared_queries");
  });
});
