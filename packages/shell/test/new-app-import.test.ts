import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  newAppImportDisplayName,
  reviewParsedNewAppRows,
} from "../src/app/new-app-import";
import { DB_WORKER_ROUTE_CENSUS } from "../src/worker/mutation-route-census";

const shellRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(shellRoot, "../..");
const source = (relative: string): string =>
  fs.readFileSync(path.join(repoRoot, relative), "utf8");

describe("new-app spreadsheet review", () => {
  it("preserves low-confidence/headerless rows until the user chooses a header", () => {
    const rows = [["Alice", "London"], ["Bob", "Paris"]];
    expect(reviewParsedNewAppRows("people.csv", rows).rows).toHaveLength(2);
    expect(reviewParsedNewAppRows("people.csv", rows, { mode: "no_header" }).rows[0])
      .toEqual({ column_1: "Alice", column_2: "London" });
  });
  it("supports an explicit header after a preamble and reports every excluded row", () => {
    const rows = [["Export", ""], ["Name", "Amount"], ["Coffee", "4"]];
    const reviewed = reviewParsedNewAppRows("expenses.csv", rows, { mode: "header", sourceRow: 2 });
    expect(reviewed.rows).toEqual([{ name: "Coffee", amount: 4 }]);
    expect(reviewed.review.skippedRows).toBe(1);
    expect(reviewParsedNewAppRows("expenses.csv", rows, { mode: "no_header" }).rows).toHaveLength(3);
  });
  it("derives a bounded lifecycle-valid name when truncation lands on a separator", () => {
    const name = newAppImportDisplayName(`${"a".repeat(39)}-details.csv`);
    expect(name).toBe("a".repeat(39));
    expect(name).toMatch(/^\S(?:.{0,38}\S)?$/s);
  });

  it("turns a bounded parsed range into typed, unique, reviewed fields", () => {
    const reviewed = reviewParsedNewAppRows("September expenses.csv", [
      ["Item name", "Amount", "When", "Item name"],
      ["Coffee", "4.50", "2026-09-01", "Cafe"],
      ["Rent", "1200", "2026-09-02", "Home"],
      ["", "", "", ""],
    ], { mode: "header", sourceRow: 1 });

    expect(reviewed.table).toBe("september_expenses");
    expect(reviewed.columns).toEqual([
      { name: "item_name", type: "text" },
      { name: "amount", type: "number" },
      { name: "when", type: "date" },
      { name: "item_name_2", type: "text" },
    ]);
    expect(reviewed.rows).toEqual([
      { item_name: "Coffee", amount: 4.5, when: "2026-09-01", item_name_2: "Cafe" },
      { item_name: "Rent", amount: 1200, when: "2026-09-02", item_name_2: "Home" },
    ]);
    expect(reviewed.review).toEqual({
      sourceRows: 3,
      acceptedRows: 2,
      skippedRows: 1,
      truncatedRows: 0,
      sourceColumns: 4,
      acceptedColumns: 4,
      truncatedColumns: 0,
    });
  });

  it("rejects an empty range before any app can be created", () => {
    expect(() => reviewParsedNewAppRows("empty.xlsx", [])).toThrow(/empty/i);
  });
});

describe("new-app import production boundary", () => {
  it("keeps legacy import closed and exposes only lifecycle-bound import and Undo", () => {
    expect(DB_WORKER_ROUTE_CENSUS.importTable).toEqual({
      enforcement: "unavailable", mutates: "live",
    });
    expect(DB_WORKER_ROUTE_CENSUS.importNewApp).toEqual({
      enforcement: "lifecycle-authority", mutates: "live",
    });
    expect(DB_WORKER_ROUTE_CENSUS.undoNewAppImport).toEqual({
      enforcement: "lifecycle-authority", mutates: "live",
    });

    const worker = source("packages/shell/src/worker/db-worker.ts");
    const authority = source("packages/kernel/src/production-authority.ts");
    const app = source("packages/shell/src/app/App.tsx");
    expect(worker).toContain("executeNewAppImport(");
    expect(worker).toContain("undoNewAppImport(");
    expect(authority).toContain("executeNewAppImport(input: unknown)");
    expect(authority).toContain("undoNewAppImport(input: unknown)");
    expect(app).toContain("parseNewAppImportFile(");
    expect(app).toContain("client().importNewApp(");
    expect(app).toContain("client().undoNewAppImport(");
    expect(app).not.toContain("Safe creation of another imported app is not available yet");
  });
});
