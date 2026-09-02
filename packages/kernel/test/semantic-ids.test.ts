import { describe, expect, it } from "vitest";
import {
  cloneActiveRegistry,
  cloneRegistry,
  registryToJson,
  type Registry,
} from "../src/registry";
import {
  createConceptId,
  createFieldId,
  createRelationshipId,
  createTableId,
  bindingForSemanticOp,
  isConceptId,
  isFieldId,
  isRelationshipId,
  isSemanticDisposition,
  isSemanticOrigin,
  isTableId,
  parseConceptId,
  parseFieldId,
  parseRelationshipId,
  parseTableId,
  semanticRegistryIssues,
  type SemanticSchemaTraceV1,
} from "../src/semantic";

describe("semantic IDs", () => {
  it("generates branded UUIDv7 wire IDs for each semantic kind", () => {
    const tableId = createTableId();
    const fieldId = createFieldId();
    const conceptId = createConceptId();
    const relationshipId = createRelationshipId();

    expect(isTableId(tableId)).toBe(true);
    expect(isFieldId(fieldId)).toBe(true);
    expect(isConceptId(conceptId)).toBe(true);
    expect(isRelationshipId(relationshipId)).toBe(true);
    expect(new Set([tableId, fieldId, conceptId, relationshipId])).toHaveLength(4);
  });

  it("accepts only the canonical lowercase UUIDv7 wire form", () => {
    const uuid = "01890f26-4c00-7abc-8def-0123456789ab";
    const tableId = `tbl_${uuid}`;
    const fieldId = `fld_${uuid}`;
    const conceptId = `cpt_${uuid}`;
    const relationshipId = `rel_${uuid}`;

    expect(parseTableId(tableId)).toBe(tableId);
    expect(parseFieldId(fieldId)).toBe(fieldId);
    expect(parseConceptId(conceptId)).toBe(conceptId);
    expect(parseRelationshipId(relationshipId)).toBe(relationshipId);

    expect(isTableId(tableId.toUpperCase())).toBe(false);
    expect(isTableId(`tbl_${uuid.replace("-7abc-", "-4abc-")}`)).toBe(false);
    expect(isTableId(`tbl_${uuid.replace("-8def-", "-7def-")}`)).toBe(false);
    expect(isTableId(`fld_${uuid}`)).toBe(false);
    expect(isTableId("tbl_tasks")).toBe(false);
    expect(isTableId(null)).toBe(false);
    expect(() => parseTableId(`tbl_${uuid.replace("-7abc-", "-4abc-")}`))
      .toThrow(/TableId/);
  });

  it("keeps origins and dispositions closed and binds exact operation coordinates", () => {
    expect(isSemanticOrigin("legacy_backfill")).toBe(true);
    expect(isSemanticOrigin("assistant_guess")).toBe(false);
    expect(isSemanticDisposition("reactivate")).toBe(true);
    expect(isSemanticDisposition("create")).toBe(false);

    const tableId = parseTableId("tbl_01890f26-4c00-7abc-8def-0123456789ab");
    const firstFieldId = parseFieldId("fld_01890f26-4c01-7abc-9def-0123456789ab");
    const secondFieldId = parseFieldId("fld_01890f26-4c02-7abc-adef-0123456789ab");
    const first = {
      ref: { version: 3, operationIndex: 1, columnIndex: 0 },
      tableId,
      fieldId: firstFieldId,
      disposition: "introduce" as const,
      origin: "model" as const,
    };
    const second = {
      ref: { version: 3, operationIndex: 1, columnIndex: 1 },
      tableId,
      fieldId: secondFieldId,
      disposition: "reactivate" as const,
      origin: "model" as const,
    };
    const trace: SemanticSchemaTraceV1 = {
      v: 1,
      atVersion: 3,
      tables: [],
      fields: [],
      relationships: [],
      opBindings: [first, second],
    };

    expect(bindingForSemanticOp(trace, first.ref)).toBe(first);
    expect(bindingForSemanticOp(trace, second.ref)).toBe(second);
    expect(bindingForSemanticOp(trace, { version: 3, operationIndex: 1 })).toBeNull();
    expect(bindingForSemanticOp(trace, {
      version: 3, operationIndex: 1, columnIndex: 2,
    })).toBeNull();
  });
});

function semanticRegistry(): Registry {
  const tableId = parseTableId("tbl_01890f26-4c00-7abc-8def-0123456789ab");
  const fieldId = parseFieldId("fld_01890f26-4c01-7abc-9def-0123456789ab");
  const relationshipId = parseRelationshipId("rel_01890f26-4c02-7abc-adef-0123456789ab");
  return new Map([["tasks", {
    name: "tasks",
    semantic: {
      v: 1,
      tableId,
      label: "Tasks",
      aliases: ["work_items"],
      origin: "seed",
      events: [{
        v: 1,
        version: 1,
        operationIndex: 0,
        disposition: "introduce",
        origin: "seed",
      }],
      relationships: [{
        v: 1,
        relationshipId,
        kind: "contains",
        fromTableId: tableId,
        toFieldId: fieldId,
        origin: "seed",
        events: [{ v: 1, version: 1, operationIndex: 0, columnIndex: 0, action: "activate" }],
      }],
    },
    columns: [{
      name: "title",
      type: "text",
      required: true,
      semantic: {
        v: 1,
        fieldId,
        label: "Title",
        aliases: ["task_title"],
        origin: "seed",
        events: [{
          v: 1,
          version: 1,
          operationIndex: 0,
          columnIndex: 0,
          disposition: "introduce",
          origin: "seed",
        }],
      },
    }],
  }]]);
}

describe("registry semantic projection boundary", () => {
  it("deeply preserves semantic metadata in internal registry clones", () => {
    const source = semanticRegistry();
    const cloned = cloneRegistry(source);
    const sourceTable = source.get("tasks")!;
    const clonedTable = cloned.get("tasks")!;

    expect(clonedTable.semantic).toEqual(sourceTable.semantic);
    expect(clonedTable.columns[0]!.semantic).toEqual(sourceTable.columns[0]!.semantic);
    expect(clonedTable.semantic).not.toBe(sourceTable.semantic);
    expect(clonedTable.semantic!.events[0]).not.toBe(sourceTable.semantic!.events[0]);
    expect(clonedTable.semantic!.relationships[0]).not
      .toBe(sourceTable.semantic!.relationships[0]);
    expect(clonedTable.semantic!.relationships[0]!.events[0]).not
      .toBe(sourceTable.semantic!.relationships[0]!.events[0]);
    expect(clonedTable.columns[0]!.semantic).not.toBe(sourceTable.columns[0]!.semantic);

    clonedTable.semantic!.aliases.push("later_name");
    clonedTable.semantic!.relationships[0]!.events.push({
      v: 1, version: 2, operationIndex: 0, action: "retire",
    });
    clonedTable.columns[0]!.semantic!.aliases.push("later_title");
    expect(sourceTable.semantic!.aliases).toEqual(["work_items"]);
    expect(sourceTable.semantic!.relationships[0]!.events).toHaveLength(1);
    expect(sourceTable.columns[0]!.semantic!.aliases).toEqual(["task_title"]);
  });

  it("strips semantic metadata from active and JSON projections", () => {
    const source = semanticRegistry();
    const projected = cloneActiveRegistry(source);
    const table = projected.get("tasks")!;

    expect(table).not.toHaveProperty("semantic");
    expect(table.columns[0]).not.toHaveProperty("semantic");
    expect(JSON.stringify([...projected.values()])).not.toContain("tbl_");
    expect(JSON.parse(registryToJson(source))).toEqual([{
      name: "tasks",
      columns: [{ name: "title", type: "text", required: true }],
    }]);
  });

  it("rejects coordinates that do not map to a real migration operation", () => {
    const source = semanticRegistry();
    source.get("tasks")!.semantic!.events[0]!.operationIndex = 999;
    const issues = semanticRegistryIssues(source, 1, new Map([[1, [1]]]));
    expect(issues.some(issue => /invalid semantic coordinate/.test(issue))).toBe(true);
  });

  it("fails closed on duplicate IDs, dangling edges, future events, and unreviewed concepts", () => {
    const source = semanticRegistry();
    const table = source.get("tasks")!;
    table.columns.push({
      name: "other", type: "text", required: false,
      semantic: {
        ...table.columns[0]!.semantic!, label: "other", aliases: [], events: [{
          ...table.columns[0]!.semantic!.events[0]!, version: 9,
        }],
      },
    });
    table.semantic!.conceptId = createConceptId();
    const contains = table.semantic!.relationships[0]!;
    if (contains.kind !== "contains") throw new Error("fixture");
    contains.toFieldId = parseFieldId("fld_01890f26-4cff-7abc-8def-0123456789ab");

    const issues = semanticRegistryIssues(source, 3);
    expect(issues.some(issue => /reuses fieldId/.test(issue))).toBe(true);
    expect(issues.some(issue => /dangling contains/.test(issue))).toBe(true);
    expect(issues.some(issue => /invalid semantic coordinate/.test(issue))).toBe(true);
    expect(issues.some(issue => /unreviewed/.test(issue))).toBe(true);
  });
});
