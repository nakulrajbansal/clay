// Starter shells (G9) must validate against the constitution: registry
// columns are ColumnSpecs, seed panel ids/placements are legal.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ColumnSpec, Ident, PanelId } from "../src/index";

const shellsPath = fileURLToPath(
  new URL("../../../specs/shells/starter-shells.json", import.meta.url));

type Shell = {
  shell_id: string;
  registry: { table: string; columns: unknown[] }[];
  seed_panels: string[];
  sample_rows: Record<string, number>;
};
const { shells } = JSON.parse(readFileSync(shellsPath, "utf8")) as {
  shells: Shell[];
};

describe("starter shells validate against the constitution", () => {
  it("the seed shells (blank + generic + business + personal + workflow)", () => {
    expect(shells).toHaveLength(13);
    expect(shells.map(s => s.shell_id)).toEqual([
      "blank", "tracker", "log", "dashboard", "small_business", "crm", "financials",
      "staff", "habits", "inventory", "approvals", "jobs", "content"]);
  });

  for (const shell of shells) {
    it(`${shell.shell_id}: registry tables and columns are valid`, () => {
      for (const t of shell.registry) {
        expect(Ident.safeParse(t.table).success).toBe(true);
        for (const c of t.columns) {
          const r = ColumnSpec.safeParse(c);
          expect(r.success,
            r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
        }
      }
    });
    it(`${shell.shell_id}: seed panel ids and placements are legal`, () => {
      for (const sp of shell.seed_panels) {
        const [id, region, order] = sp.split(":");
        expect(PanelId.safeParse(id).success, sp).toBe(true);
        expect(["top", "main", "side"]).toContain(region);
        expect(Number.isInteger(Number(order))).toBe(true);
      }
    });
    it(`${shell.shell_id}: sample rows reference registered tables`, () => {
      const tables = new Set(shell.registry.map(t => t.table));
      for (const t of Object.keys(shell.sample_rows)) {
        expect(tables.has(t)).toBe(true);
      }
    });
  }
});
