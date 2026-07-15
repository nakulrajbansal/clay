import { describe, it, expect } from "vitest";
import { parseImportFile, sanitizeIdent } from "../src/app/importData";

describe("parseImportFile", () => {
  it("parses CSV, infers types, and coerces typed rows", () => {
    const csv = [
      "Name,Amount,Category,Due Date",
      "Coffee beans,4.50,supplies,2026-01-05",
      "Office rent,1200,rent,2026-01-01",
      "Latte cups,3,supplies,2026-01-06",
      "Milk,2.10,supplies,2026-01-07",
      "Insurance,340,rent,2026-01-02",
      "Napkins,1.5,supplies,2026-01-08",
    ].join("\n");
    const r = parseImportFile(csv, "Expenses 2026.csv");
    expect(r.table).toBe("expenses_2026");
    const by = Object.fromEntries(r.columns.map(c => [c.name, c]));
    expect(by.amount!.type).toBe("number");
    expect(by.due_date!.type).toBe("date");
    expect(by.category!.type).toBe("enum");
    expect(by.category!.values).toEqual(expect.arrayContaining(["supplies", "rent"]));
    // name has many distinct values → stays text, not enum
    expect(by.name!.type).toBe("text");
    expect(r.rows).toHaveLength(6);
    expect(r.rows[0]).toMatchObject({ name: "Coffee beans", amount: 4.5, category: "supplies", due_date: "2026-01-05" });
  });

  it("handles quoted fields with embedded commas and newlines", () => {
    const csv = 'Item,Note\n"Widget, deluxe","line one\nline two"\nGadget,plain';
    const r = parseImportFile(csv, "items.csv");
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]!.item).toBe("Widget, deluxe");
    expect(r.rows[0]!.note).toBe("line one\nline two");
  });

  it("parses a JSON array of objects with a ragged shape", () => {
    const json = JSON.stringify([
      { title: "Buy milk", done: true, priority: 2 },
      { title: "Walk dog", done: false },
    ]);
    const r = parseImportFile(json, "todos.json");
    const names = r.columns.map(c => c.name).sort();
    expect(names).toEqual(["done", "priority", "title"]);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ title: "Buy milk", done: "true", priority: 2 });
    // missing key on second row is simply absent, not null
    expect(r.rows[1]).not.toHaveProperty("priority");
  });

  it("sanitizes and de-duplicates awkward headers", () => {
    const csv = "First Name,First Name,3rd,\nA,B,C,D";
    const r = parseImportFile(csv, "x.csv");
    const names = r.columns.map(c => c.name);
    expect(names[0]).toBe("first_name");
    expect(names[1]).toBe("first_name_2");
    expect(names[2]).toBe("c_3rd");
    expect(names[3]).toBe("column_4");
  });

  it("throws a friendly error for an empty file", () => {
    expect(() => parseImportFile("", "empty.csv")).toThrow(/No columns/);
  });

  it("sanitizeIdent produces safe snake_case", () => {
    expect(sanitizeIdent("Total ($)", "x")).toBe("total");
    expect(sanitizeIdent("2024", "x")).toBe("c_2024");
    expect(sanitizeIdent("", "fallback")).toBe("fallback");
  });
});
