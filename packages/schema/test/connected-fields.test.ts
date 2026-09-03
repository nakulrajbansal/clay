import { describe, expect, it } from "vitest";
import { ColumnSpec } from "../src/index";

describe("connected and content field contracts", () => {
  it("accepts a bounded linked-record field", () => {
    expect(ColumnSpec.parse({
      name: "customer", type: "relation", required: false,
      relation: { target_table: "customers", cardinality: "one", display_field: "name" },
    })).toMatchObject({ type: "relation", relation: { target_table: "customers" } });
    expect(ColumnSpec.parse({
      name: "tasks", type: "relation", required: false,
      relation: { target_table: "tasks", cardinality: "many", display_field: "title" },
    }).relation?.cardinality).toBe("many");
  });

  it("accepts live lookup and rollup fields", () => {
    expect(ColumnSpec.parse({
      name: "customer_name", type: "lookup", required: false,
      lookup: { relation_field: "customer", target_field: "name" },
    }).type).toBe("lookup");
    expect(ColumnSpec.parse({
      name: "unpaid_total", type: "rollup", required: false,
      rollup: { relation_field: "invoices", target_field: "amount", operation: "sum" },
    }).type).toBe("rollup");
    expect(ColumnSpec.parse({
      name: "task_count", type: "rollup", required: false,
      rollup: { relation_field: "tasks", operation: "count" },
    }).type).toBe("rollup");
  });

  it("accepts portable rich notes and local attachments", () => {
    expect(ColumnSpec.parse({ name: "notes", type: "rich_text", required: false }).type)
      .toBe("rich_text");
    expect(ColumnSpec.parse({ name: "files", type: "attachment", required: false }).type)
      .toBe("attachment");
  });

  it("rejects missing, crossed, and unsafe field metadata", () => {
    expect(ColumnSpec.safeParse({ name: "customer", type: "relation", required: false }).success)
      .toBe(false);
    expect(ColumnSpec.safeParse({
      name: "customer", type: "text", required: false,
      relation: { target_table: "customers", cardinality: "one" },
    }).success).toBe(false);
    expect(ColumnSpec.safeParse({
      name: "total", type: "rollup", required: false,
      rollup: { relation_field: "items", operation: "sum" },
    }).success).toBe(false);
    expect(ColumnSpec.safeParse({
      name: "files", type: "attachment", required: true,
    }).success).toBe(false);
  });
});
