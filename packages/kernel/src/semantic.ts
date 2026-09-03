import { uuidv7 } from "./rows";
import type { Registry } from "./registry";

export type TableId = string & { readonly __brand: "TableId" };
export type FieldId = string & { readonly __brand: "FieldId" };
export type ConceptId = string & { readonly __brand: "ConceptId" };
export type RelationshipId = string & { readonly __brand: "RelationshipId" };
export type SemanticId = TableId | FieldId | ConceptId | RelationshipId;

export const SEMANTIC_ORIGINS = [
  "seed", "import", "model", "direct", "legacy_backfill", "system",
] as const;
export type SemanticOrigin = typeof SEMANTIC_ORIGINS[number];

export const SEMANTIC_DISPOSITIONS = [
  "introduce", "reactivate", "modify", "legacy_unknown",
] as const;
export type SemanticDisposition = typeof SEMANTIC_DISPOSITIONS[number];

export type SemanticOpCoordinate = {
  version: number;
  operationIndex: number;
  columnIndex?: number;
};

export type SemanticIdentityEventV1 = SemanticOpCoordinate & {
  v: 1;
  disposition: SemanticDisposition;
  origin: SemanticOrigin;
};

export type RelationshipLifecycleEventV1 = SemanticOpCoordinate & {
  v: 1;
  action: "activate" | "retire";
};

export type RelationshipBaseV1 = {
  v: 1;
  relationshipId: RelationshipId;
  origin: SemanticOrigin;
  baselineActive?: boolean;
  events: RelationshipLifecycleEventV1[];
};
export type RelationshipBase = RelationshipBaseV1;

export type ContainsRelationshipV1 = RelationshipBaseV1 & {
  kind: "contains";
  fromTableId: TableId;
  toFieldId: FieldId;
};

export type DerivedFromRelationshipV1 = RelationshipBaseV1 & {
  kind: "derived_from";
  fromFieldId: FieldId;
  toFieldId: FieldId;
};

export type ReferencesRelationshipV1 = RelationshipBaseV1 & {
  kind: "references";
  fromTableId: TableId;
  toTableId: TableId;
  viaFieldId: FieldId;
  cardinality: "many_to_one" | "one_to_one" | "one_to_many" | "many_to_many";
  integrity: "semantic_only";
  reviewed: true;
};

export type SemanticRelationshipRecordV1 =
  | ContainsRelationshipV1
  | DerivedFromRelationshipV1
  | ReferencesRelationshipV1;

export type TableSemanticV1 = {
  v: 1;
  tableId: TableId;
  conceptId?: ConceptId;
  conceptReviewed?: true;
  label: string;
  aliases: string[];
  origin: SemanticOrigin;
  events: SemanticIdentityEventV1[];
  relationships: SemanticRelationshipRecordV1[];
};

export type FieldSemanticV1 = {
  v: 1;
  fieldId: FieldId;
  conceptId?: ConceptId;
  conceptReviewed?: true;
  label: string;
  aliases: string[];
  origin: SemanticOrigin;
  events: SemanticIdentityEventV1[];
};

export type PreparedSemanticAssignmentsV1 = {
  v: 1;
  version: number;
  origin: SemanticOrigin;
  tables: ReadonlyMap<string, TableId>;
  fields: ReadonlyMap<string, FieldId>;
  relationships: ReadonlyMap<string, RelationshipId>;
  tableSemantics: ReadonlyMap<string, TableSemanticV1>;
  fieldSemantics: ReadonlyMap<string, FieldSemanticV1>;
};

export type SemanticOpBindingV1 = {
  ref: SemanticOpCoordinate;
  tableId: TableId;
  fieldId?: FieldId;
  disposition: SemanticDisposition;
  origin: SemanticOrigin;
};
export type SemanticOpBinding = SemanticOpBindingV1;

export type SemanticSchemaTraceV1 = {
  v: 1;
  atVersion: number;
  tables: readonly {
    tableId: TableId;
    conceptId?: ConceptId;
    name: string;
    label: string;
    aliases: readonly string[];
    state: "visible" | "inactive";
  }[];
  fields: readonly {
    tableId: TableId;
    fieldId: FieldId;
    conceptId?: ConceptId;
    tableName: string;
    fieldName: string;
    label: string;
    aliases: readonly string[];
    state: "visible" | "hidden" | "inactive";
  }[];
  relationships: readonly {
    relationshipId: RelationshipId;
    kind: "contains" | "derived_from" | "references";
    state: "active" | "hidden" | "inactive" | "retired";
    from: TableId | FieldId;
    to: TableId | FieldId;
    via?: FieldId;
  }[];
  opBindings: readonly SemanticOpBindingV1[];
};

export function isSemanticOrigin(value: unknown): value is SemanticOrigin {
  return typeof value === "string" &&
    (SEMANTIC_ORIGINS as readonly string[]).includes(value);
}

export function isSemanticDisposition(value: unknown): value is SemanticDisposition {
  return typeof value === "string" &&
    (SEMANTIC_DISPOSITIONS as readonly string[]).includes(value);
}

function sameSemanticOpCoordinate(
  left: SemanticOpCoordinate,
  right: SemanticOpCoordinate,
): boolean {
  return left.version === right.version &&
    left.operationIndex === right.operationIndex &&
    left.columnIndex === right.columnIndex;
}

export function bindingForSemanticOp(
  trace: SemanticSchemaTraceV1,
  ref: SemanticOpCoordinate,
): SemanticOpBindingV1 | null {
  return trace.opBindings.find(binding => sameSemanticOpCoordinate(binding.ref, ref)) ?? null;
}

const UUID_V7 = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const TABLE_ID = new RegExp(`^tbl_${UUID_V7}$`);
const FIELD_ID = new RegExp(`^fld_${UUID_V7}$`);
const CONCEPT_ID = new RegExp(`^cpt_${UUID_V7}$`);
const RELATIONSHIP_ID = new RegExp(`^rel_${UUID_V7}$`);

export function isTableId(value: unknown): value is TableId {
  return typeof value === "string" && TABLE_ID.test(value);
}

export function isFieldId(value: unknown): value is FieldId {
  return typeof value === "string" && FIELD_ID.test(value);
}

export function isConceptId(value: unknown): value is ConceptId {
  return typeof value === "string" && CONCEPT_ID.test(value);
}

export function isRelationshipId(value: unknown): value is RelationshipId {
  return typeof value === "string" && RELATIONSHIP_ID.test(value);
}

function invalidSemanticId(kind: string, value: unknown): never {
  throw new TypeError(`invalid ${kind}: ${String(value)}`);
}

export function parseTableId(value: unknown): TableId {
  return isTableId(value) ? value : invalidSemanticId("TableId", value);
}

export function parseFieldId(value: unknown): FieldId {
  return isFieldId(value) ? value : invalidSemanticId("FieldId", value);
}

export function parseConceptId(value: unknown): ConceptId {
  return isConceptId(value) ? value : invalidSemanticId("ConceptId", value);
}

export function parseRelationshipId(value: unknown): RelationshipId {
  return isRelationshipId(value) ? value : invalidSemanticId("RelationshipId", value);
}

export function createTableId(): TableId {
  return `tbl_${uuidv7()}` as TableId;
}

export function createFieldId(): FieldId {
  return `fld_${uuidv7()}` as FieldId;
}

export function createConceptId(): ConceptId {
  return `cpt_${uuidv7()}` as ConceptId;
}

export function createRelationshipId(): RelationshipId {
  return `rel_${uuidv7()}` as RelationshipId;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Per version, each array item is one migration operation. A number is the
 * valid create-table column count; null means the operation has no column
 * coordinate. Version zero is the only allowed synthetic legacy baseline. */
export type SemanticOperationBounds = ReadonlyMap<number, readonly (number | null)[]>;

export function semanticRegistryIssues(
  registry: Registry,
  headVersion: number,
  operationBounds?: SemanticOperationBounds,
): string[] {
  const issues: string[] = [];
  const tableIds = new Set<string>();
  const fieldIds = new Set<string>();
  const relationshipIds = new Set<string>();
  const tableById = new Map<string, { name: string; fieldIds: Set<string> }>();
  const fieldOwner = new Map<string, string>();
  const coordinateIssues = (events: unknown, subject: string, lifecycle: boolean): void => {
    if (!Array.isArray(events)) { issues.push(`${subject} semantic events are missing`); return; }
    for (const event of events) {
      if (!isRecord(event) || event.v !== 1
          || !Number.isInteger(event.version) || Number(event.version) < 0
          || Number(event.version) > headVersion
          || !Number.isInteger(event.operationIndex) || Number(event.operationIndex) < 0
          || (event.columnIndex !== undefined
            && (!Number.isInteger(event.columnIndex) || Number(event.columnIndex) < 0))) {
        issues.push(`${subject} has an invalid semantic coordinate`);
        continue;
      }
      if (operationBounds && Number(event.version) > 0) {
        const operations = operationBounds.get(Number(event.version));
        const operationIndex = Number(event.operationIndex);
        const columnIndex = event.columnIndex === undefined
          ? undefined : Number(event.columnIndex);
        const columnCount = operations?.[operationIndex];
        if (!operations || operationIndex >= operations.length
            || (columnIndex !== undefined
              && (typeof columnCount !== "number" || columnIndex >= columnCount))) {
          issues.push(`${subject} has an invalid semantic coordinate`);
          continue;
        }
      }
      if (lifecycle) {
        if (event.action !== "activate" && event.action !== "retire")
          issues.push(`${subject} has an invalid relationship action`);
      } else if (!isSemanticOrigin(event.origin)
          || !isSemanticDisposition(event.disposition)) {
        issues.push(`${subject} has an invalid identity event`);
      }
    }
  };
  const common = (
    semantic: unknown, subject: string, idKey: "tableId" | "fieldId",
    validId: (value: unknown) => boolean, seen: Set<string>,
  ): semantic is Record<string, unknown> => {
    if (!isRecord(semantic) || semantic.v !== 1) {
      issues.push(`${subject} is missing semantic metadata`); return false;
    }
    const id = semantic[idKey];
    if (!validId(id)) issues.push(`${subject} has an invalid ${idKey}`);
    else if (seen.has(String(id))) issues.push(`${subject} reuses ${idKey} '${String(id)}'`);
    else seen.add(String(id));
    if (typeof semantic.label !== "string" || semantic.label.length === 0
        || semantic.label.length > 128) issues.push(`${subject} has an invalid semantic label`);
    if (!Array.isArray(semantic.aliases) || semantic.aliases.length > 64
        || semantic.aliases.some(alias => typeof alias !== "string" || alias.length > 128))
      issues.push(`${subject} has invalid semantic aliases`);
    if (!isSemanticOrigin(semantic.origin)) issues.push(`${subject} has an invalid semantic origin`);
    if (semantic.conceptId !== undefined
        && (!isConceptId(semantic.conceptId) || semantic.conceptReviewed !== true))
      issues.push(`${subject} has an unreviewed or invalid concept classification`);
    coordinateIssues(semantic.events, subject, false);
    return true;
  };

  for (const [name, table] of registry) {
    if (!common(table.semantic, `table '${name}'`, "tableId", isTableId, tableIds)) continue;
    const tableId = String(table.semantic.tableId);
    const owned = new Set<string>();
    tableById.set(tableId, { name, fieldIds: owned });
    if (!Array.isArray(table.columns)) {
      issues.push(`table '${name}' has no semantic columns`); continue;
    }
    for (const column of table.columns) {
      const subject = `field '${name}.${String(column.name)}'`;
      if (!common(column.semantic, subject, "fieldId", isFieldId, fieldIds)) continue;
      const fieldId = String(column.semantic.fieldId);
      owned.add(fieldId); fieldOwner.set(fieldId, tableId);
    }
  }

  const tuples = new Set<string>();
  for (const [name, table] of registry) {
    if (!isRecord(table.semantic) || !Array.isArray(table.semantic.relationships)) {
      issues.push(`table '${name}' has invalid semantic relationships`); continue;
    }
    const ownerId = String(table.semantic.tableId ?? "");
    const containsByField = new Map<string, number>();
    for (const relationship of table.semantic.relationships) {
      const subject = `relationship in table '${name}'`;
      if (!isRecord(relationship) || relationship.v !== 1
          || !isRelationshipId(relationship.relationshipId)) {
        issues.push(`${subject} has an invalid relationship ID`); continue;
      }
      const relationshipId = String(relationship.relationshipId);
      if (relationshipIds.has(relationshipId))
        issues.push(`${subject} reuses relationshipId '${relationshipId}'`);
      relationshipIds.add(relationshipId);
      if (!isSemanticOrigin(relationship.origin))
        issues.push(`${subject} has an invalid relationship origin`);
      coordinateIssues(relationship.events, subject, true);
      let tuple = "";
      if (relationship.kind === "contains") {
        const from = String(relationship.fromTableId ?? "");
        const to = String(relationship.toFieldId ?? "");
        tuple = `contains\u0000${from}\u0000${to}`;
        if (from !== ownerId || fieldOwner.get(to) !== ownerId)
          issues.push(`${subject} has dangling contains endpoints`);
        containsByField.set(to, (containsByField.get(to) ?? 0) + 1);
      } else if (relationship.kind === "derived_from") {
        const from = String(relationship.fromFieldId ?? "");
        const to = String(relationship.toFieldId ?? "");
        tuple = `derived_from\u0000${from}\u0000${to}`;
        if (fieldOwner.get(from) !== ownerId || fieldOwner.get(to) !== ownerId)
          issues.push(`${subject} has dangling derived_from endpoints`);
      } else if (relationship.kind === "references") {
        const from = String(relationship.fromTableId ?? "");
        const to = String(relationship.toTableId ?? "");
        const via = String(relationship.viaFieldId ?? "");
        tuple = `references\u0000${from}\u0000${to}\u0000${via}`;
        if (from !== ownerId || !tableById.has(to) || fieldOwner.get(via) !== ownerId
            || relationship.reviewed !== true || relationship.integrity !== "semantic_only")
          issues.push(`${subject} has invalid reviewed reference endpoints`);
      } else {
        issues.push(`${subject} has an unknown relationship kind`); continue;
      }
      if (tuples.has(tuple)) issues.push(`${subject} duplicates a typed endpoint tuple`);
      tuples.add(tuple);
    }
    for (const fieldId of tableById.get(ownerId)?.fieldIds ?? []) {
      if (containsByField.get(fieldId) !== 1)
        issues.push(`field '${fieldId}' must have exactly one contains relationship`);
    }
  }
  return issues;
}
