// P0.3 freeze verification: every hand-written exemplar (specs/exemplars)
// must validate against the frozen Zod constitution. Exemplar 10's known
// defect is V4-level (undeclared clients query) and must NOT fail here.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MutationPlan } from "../src/index";

const exemplarsDir = fileURLToPath(
  new URL("../../../specs/exemplars/", import.meta.url));

function loadExemplar(file: string): unknown {
  const md = readFileSync(join(exemplarsDir, file), "utf8");
  const m = md.match(/```json\s*\n([\s\S]*?)```/);
  if (!m || !m[1]) throw new Error(`no json block in ${file}`);
  return JSON.parse(m[1]);
}

const files = readdirSync(exemplarsDir)
  .filter(f => /^(0[1-9]|10)-.*\.md$/.test(f));

describe("exemplars validate against the frozen MutationPlan schema", () => {
  it("finds all ten exemplars", () => expect(files).toHaveLength(10));
  for (const f of files) {
    it(f, () => {
      const r = MutationPlan.safeParse(loadExemplar(f));
      expect(r.success,
        r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
    });
  }
});

describe("exemplar-specific contracts", () => {
  it("exemplar 7 is a pure clarify plan (G18)", () => {
    const p = MutationPlan.parse(loadExemplar("07-clarify.md"));
    expect(p.clarifying_question).toBeTruthy();
    expect(p.migration).toBeNull();
    expect(p.panels).toHaveLength(0);
    expect(p.remove_panels).toHaveLength(0);
    expect(p.summary).toBe("");
  });

  it("exemplar 3 creates the computed health_score (G19)", () => {
    const p = MutationPlan.parse(loadExemplar("03-computed-and-strip.md"));
    expect(p.migration?.operations.some(
      o => o.op === "create_computed" && o.column === "health_score",
    )).toBe(true);
    expect(p.panels.map(x => x.panel_id))
      .toEqual(["health_alerts", "project_table"]);
  });

  it("exemplar 5 declares its write table (G22/ADR-014)", () => {
    const p = MutationPlan.parse(loadExemplar("05-form.md"));
    expect(p.panels[0]?.declared_writes).toEqual(["appointments"]);
  });

  it("exemplar 10 passes Zod; its planted defect is for V4", () => {
    const p = MutationPlan.parse(loadExemplar("10-out-of-scope.md"));
    // The code also queries `clients`; that query is intentionally missing
    // from declared_queries (see the exemplar's NOTE). The Validator must
    // catch it — the schema alone cannot, and this asserts the fixture
    // stays planted.
    expect(p.panels[0]?.declared_queries.map(q => q.from))
      .toEqual(["appointments"]);
  });
});
