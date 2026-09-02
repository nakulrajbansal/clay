// ClayStore: the trusted facade over user.db + system.db. Commits span
// DDL + backfills + registry update + version_log append in ONE
// transaction (doc 04 §4). Versioning is a linear chain (doc 04 §5):
// rollback applies inverses; roll-forward (pre-truncation) re-applies
// forward ops; truncation is the only destructive-ish operation (ADR-007).
import { ClayError } from "./errors";
import {
  copyDatabase, createSystemTables, openDriverFromBytes, openMemoryDriver,
  type DbDriver, type SqlRow, type SqlValue,
} from "./db";
import { zipRead, zipWrite } from "./zip";
import { validateMutationPlan } from "./validate";
import {
  cloneActiveRegistry, cloneFieldSemantic, cloneRegistry, cloneTableSemantic,
  findStoredColumn, getTable, type Registry, type RegColumn, type RegTable,
} from "./registry";
import { nowIso, uuidv7, validateInsert, validatePatch } from "./rows";
import {
  applyForwardOps, applyInverseOps, validateMigrationPlan,
  type MigrationPlanT,
} from "./migrate";
import { runQuery, type QueryRow } from "./query";
import { exprFields, parseExpr } from "./expr";
import { Observer, type Suggestion, type UsageEvent } from "./observe";
import {
  PrivateMetricsReducer, type PrivateMetricEvent, type PrivateMetricsSummary,
} from "./private-metrics";
import { SqlitePrivateMetricDriver } from "./private-metrics-sqlite";
import {
  createFieldId, createRelationshipId, createTableId, semanticRegistryIssues,
  type FieldId, type FieldSemanticV1, type PreparedSemanticAssignmentsV1,
  type SemanticIdentityEventV1, type SemanticOperationBounds, type SemanticOrigin,
  type SemanticRelationshipRecordV1, type SemanticSchemaTraceV1,
  type TableId, type TableSemanticV1,
} from "./semantic";

type QueryT = import("@clay/schema").Query;

export type PanelBlobInput = {
  panel_id: string;
  title: string;
  placement: { region: "top" | "main" | "side"; order: number; w?: number; h?: number; col?: number };
  code: string;
  declared_queries: QueryT[];
  declared_writes: string[];
};

export type LivePanel = PanelBlobInput & { version: number };

export type PanelProvenance = {
  panel_id: string;
  createdVersion: number;
  lastChangedVersion: number;
  createdAt: string;
  lastChangedAt: string;
  createdIntent: string;
  lastChangedIntent: string;
  createdSummary: string;
  lastChangedSummary: string;
};

export type FieldProvenance = {
  tableId: TableId;
  fieldId: FieldId;
  tableName: string;
  fieldName: string;
  fieldType: string;
  aliases: string[];
  origin: SemanticOrigin;
  state: "visible" | "hidden" | "inactive";
  createdVersion: number;
  lastChangedVersion: number;
  derivation?: { expression: string; dependencyFieldIds: FieldId[] };
};

export type CommitInput = {
  intent: string;
  summary: string;
  migration: MigrationPlanT | null;
  semanticOrigin?: SemanticOrigin;
  semanticAssignments?: PreparedSemanticAssignmentsV1;
  panels?: PanelBlobInput[];
  removePanels?: string[];
  diff?: unknown;
};

/** G16/I4: rewrite field references in a declared query after a rename. */
function renameQueryFields(q: QueryT, table: string, from: string, to: string): QueryT {
  if (q.from !== table) return q;
  const field = (f: string): string => (f === from ? to : f);
  const out: QueryT = { ...q };
  if (out.select) out.select = out.select.map(field);
  if (out.where) out.where = out.where.map(c => ({ ...c, field: field(c.field) }));
  if (out.orWhere) out.orWhere = out.orWhere.map(g => g.map(c => ({ ...c, field: field(c.field) })));
  if (out.orderBy) out.orderBy = out.orderBy.map(o => ({ ...o, field: field(o.field) }));
  if (out.groupBy) out.groupBy = out.groupBy.map(field);
  if (out.aggregate) out.aggregate = out.aggregate.map(a => ({ ...a, field: field(a.field) }));
  return out;
}

export type VersionEntry = {
  version: number;
  parent: number;
  created_at: string;
  intent_text: string;
  summary: string;
  migration: MigrationPlanT | null;
};

export type HistoryEntry = Omit<VersionEntry, "migration"> & {
  label?: string;
  diff?: { kind: string; detail: string }[];   // what changed at this version
};

const qid = (name: string): string => `"${name}"`;

/** Parse a stored diff_json into user-facing {kind, detail} lines, tolerantly. */
function parseDiff(json: string): { kind: string; detail: string }[] {
  try {
    const arr = JSON.parse(json) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((d): d is { kind?: unknown; detail?: unknown } => !!d && typeof d === "object")
      .map(d => ({ kind: String(d.kind ?? "change"), detail: String(d.detail ?? "") }))
      .filter(d => d.detail !== "");
  } catch { return []; }
}

export class ClayStore {
  private reg: Registry = new Map();
  readonly observer: Observer;
  readonly privateMetrics: PrivateMetricsReducer;

  private constructor(private readonly driver: DbDriver) {
    this.observer = new Observer(driver);
    this.privateMetrics = new PrivateMetricsReducer(new SqlitePrivateMetricDriver(driver));
  }

  static async openMemory(): Promise<ClayStore> {
    return ClayStore.fromDriver(await openMemoryDriver());
  }

  /** Bind a store to an already-open driver (browser worker, imports). */
  static fromDriver(
    driver: DbDriver,
    options: { requireSemanticRegistry?: boolean } = {},
  ): ClayStore {
    createSystemTables(driver);
    // G6: row-level undo lives in user.db so it travels with exports.
    driver.exec(`CREATE TABLE IF NOT EXISTS "row_history"(
      "id" TEXT PRIMARY KEY, "table" TEXT NOT NULL, "row_id" TEXT NOT NULL,
      "at" TEXT NOT NULL, "before_json" TEXT NOT NULL)`);
    const store = new ClayStore(driver);
    try {
      store.migrateLayoutScheme();
      store.loadRegistry();
      const current = store.currentVersion();
      const guard = driver.select(
        "SELECT value_json FROM sys.settings WHERE key = 'semantic_registry_v1'",
      )[0];
      if (options.requireSemanticRegistry || guard) {
        const semanticIssues = semanticRegistryIssues(
          store.reg, store.headVersion(), store.semanticOperationBounds(),
        );
        if (semanticIssues.length > 0)
          throw new ClayError("E_VALIDATION",
            `semantic registry failed integrity checks: ${semanticIssues.join("; ")}`,
            semanticIssues);
        if (!guard) driver.tx(() => {
          driver.exec(`INSERT OR REPLACE INTO sys.settings(key, value_json)
            VALUES ('semantic_registry_v1', 'true')`);
        });
      } else {
        driver.tx(() => {
          const prepared = store.prepareSemanticAssignments(null, "legacy_backfill");
          if (store.ensureSemanticMetadata(prepared.version, "legacy_backfill", prepared))
            store.persistRegistry(current);
          driver.exec(`INSERT OR REPLACE INTO sys.settings(key, value_json)
            VALUES ('semantic_registry_v1', 'true')`);
        });
      }
      return store;
    } catch (error) {
      driver.close();
      throw error;
    }
  }

  /**
   * ADR-018: the main region went from a 2-column to a 4-column grid, so a
   * stored width means a different fraction. Remap every panel blob's width
   * ONCE (old half w:1 -> w:2, old full w:2 -> w:4) so existing layouts keep
   * their proportions. Guarded by a settings flag; new apps skip it.
   */
  private migrateLayoutScheme(): void {
    const done = this.driver.select(
      "SELECT value_json FROM sys.settings WHERE key = 'layout_scheme'")[0];
    if (done && String(done.value_json) === "2") return;
    const rows = this.driver.select(
      "SELECT version, panel_id, placement_json FROM sys.panel_blobs");
    for (const r of rows) {
      let pl: { w?: number } & Record<string, unknown>;
      try { pl = JSON.parse(String(r.placement_json)); } catch { continue; }
      const remap = pl.w === 1 ? 2 : pl.w === 2 ? 4 : undefined;
      if (remap === undefined) continue;
      pl.w = remap;
      this.driver.exec(
        "UPDATE sys.panel_blobs SET placement_json = ? WHERE version = ? AND panel_id = ?",
        [JSON.stringify(pl), Number(r.version), String(r.panel_id)]);
    }
    this.driver.exec(
      "INSERT OR REPLACE INTO sys.settings(key, value_json) VALUES ('layout_scheme', '2')");
  }

  /** G6 ring cap; public so tests can lower it. */
  rowHistoryCap = 10_000;

  close(): void {
    this.driver.close();
  }

  // ---------- registry ----------
  private loadRegistry(): void {
    this.reg = new Map();
    for (const row of this.driver.select("SELECT spec_json FROM sys.tables_registry")) {
      const spec = JSON.parse(String(row.spec_json)) as RegTable;
      this.reg.set(spec.name, spec);
    }
  }

  private ensureSemanticMetadata(
    version: number,
    origin: SemanticOrigin,
    prepared?: PreparedSemanticAssignmentsV1,
  ): boolean {
    if (prepared) {
      if (prepared.origin !== origin || prepared.version !== version)
        throw new ClayError("E_VALIDATION", "semantic assignment does not match this commit");
      let changed = false;
      for (const table of this.reg.values()) {
        const tableSemantic = prepared.tableSemantics.get(table.name);
        if (!tableSemantic)
          throw new ClayError("E_VALIDATION", `semantic assignment is missing table '${table.name}'`);
        table.semantic = cloneTableSemantic(tableSemantic);
        for (const column of table.columns) {
          const fieldSemantic = prepared.fieldSemantics.get(`${table.name}\u0000${column.name}`);
          if (!fieldSemantic)
            throw new ClayError("E_VALIDATION",
              `semantic assignment is missing field '${table.name}.${column.name}'`);
          column.semantic = cloneFieldSemantic(fieldSemantic);
        }
        changed = true;
      }
      return changed;
    }

    // Legacy-only fallback. New commits prepare exact operation bindings before
    // either shadow or live execution; this path upgrades pre-semantic stores.
    let changed = false;
    for (const table of this.reg.values()) {
      if (!table.semantic) {
        table.semantic = {
          v: 1, tableId: createTableId(), label: table.name, aliases: [],
          origin: "legacy_backfill",
          events: [{ v: 1, version, operationIndex: 0,
            disposition: "legacy_unknown", origin: "legacy_backfill" }],
          relationships: [],
        };
        changed = true;
      }
      table.columns.forEach((column, columnIndex) => {
        if (!column.semantic) {
          column.semantic = {
            v: 1, fieldId: createFieldId(), label: column.name, aliases: [],
            origin: "legacy_backfill",
            events: [{ v: 1, version, operationIndex: 0, columnIndex,
              disposition: "legacy_unknown", origin: "legacy_backfill" }],
          };
          changed = true;
        }
        const fieldId = column.semantic.fieldId;
        if (!table.semantic!.relationships.some(relationship =>
          relationship.kind === "contains" && relationship.toFieldId === fieldId)) {
          table.semantic!.relationships.push({
            v: 1, kind: "contains", relationshipId: createRelationshipId(),
            origin: "legacy_backfill", fromTableId: table.semantic!.tableId,
            toFieldId: fieldId, baselineActive: !column.inactive,
            events: [{ v: 1, version, operationIndex: 0, columnIndex,
              action: "activate" }],
          });
          changed = true;
        }
      });
    }
    return changed;
  }

  prepareSemanticAssignments(
    migration: MigrationPlanT | null,
    origin: SemanticOrigin,
  ): PreparedSemanticAssignmentsV1 {
    if (migration) validateMigrationPlan(migration, this.reg);
    const version = origin === "legacy_backfill" && migration === null
      ? 0 : this.headVersion() + 1;
    const sim = cloneRegistry(this.reg);
    const ref = (operationIndex: number, columnIndex?: number) => ({
      version, operationIndex, ...(columnIndex === undefined ? {} : { columnIndex }),
    });
    const fieldKey = (table: string, field: string): string => `${table}\u0000${field}`;
    const relationKey = (kind: string, from: string, to: string): string =>
      `${kind}\u0000${from}\u0000${to}`;
    const addAlias = (aliases: string[], label: string): void => {
      if (!aliases.includes(label)) aliases.push(label);
      if (aliases.length > 64) aliases.splice(0, aliases.length - 64);
    };
    const columnFrom = (column: {
      name: string; type: RegColumn["type"]; required?: boolean;
      values?: string[]; expr?: string;
    }): RegColumn => ({
      name: column.name, type: column.type, required: column.required ?? false,
      ...(column.values ? { values: [...column.values] } : {}),
      ...(column.expr !== undefined ? { expr: column.expr } : {}),
    });
    const newTableSemantic = (
      name: string, operationIndex: number,
      disposition: SemanticIdentityEventV1["disposition"],
    ): TableSemanticV1 => ({
      v: 1, tableId: createTableId(), label: name, aliases: [], origin,
      events: [{ v: 1, ...ref(operationIndex), disposition, origin }],
      relationships: [],
    });
    const newFieldSemantic = (
      name: string, operationIndex: number,
      disposition: SemanticIdentityEventV1["disposition"],
      columnIndex?: number,
    ): FieldSemanticV1 => ({
      v: 1, fieldId: createFieldId(), label: name, aliases: [], origin,
      events: [{ v: 1, ...ref(operationIndex, columnIndex), disposition, origin }],
    });
    const pushFieldEvent = (
      column: RegColumn, operationIndex: number,
      disposition: SemanticIdentityEventV1["disposition"] = "modify",
      columnIndex?: number,
    ): void => {
      column.semantic!.events.push({
        v: 1, ...ref(operationIndex, columnIndex), disposition, origin,
      });
    };
    const lastAction = (relationship: SemanticRelationshipRecordV1): "activate" | "retire" | null =>
      relationship.events.at(-1)?.action ?? (relationship.baselineActive ? "activate" : null);
    const activateContains = (
      table: RegTable, column: RegColumn, operationIndex: number,
      columnIndex?: number, force = false,
    ): void => {
      const semantic = table.semantic!;
      const fieldId = column.semantic!.fieldId;
      let relationship = semantic.relationships.find(candidate =>
        candidate.kind === "contains" && candidate.toFieldId === fieldId);
      if (!relationship) {
        relationship = {
          v: 1, kind: "contains", relationshipId: createRelationshipId(), origin,
          fromTableId: semantic.tableId, toFieldId: fieldId,
          events: [{ v: 1, ...ref(operationIndex, columnIndex), action: "activate" }],
        };
        semantic.relationships.push(relationship);
      } else if (force || lastAction(relationship) !== "activate") {
        relationship.events.push({
          v: 1, ...ref(operationIndex, columnIndex), action: "activate",
        });
      }
    };
    const syncDerived = (
      table: RegTable, computed: RegColumn, expression: string,
      operationIndex: number, force = false,
    ): void => {
      const fromFieldId = computed.semantic!.fieldId;
      const desired = new Set([...exprFields(parseExpr(expression))].map(name =>
        table.columns.find(column => column.name === name)?.semantic?.fieldId
      ).filter((id): id is FieldId => id !== undefined));
      const existing = table.semantic!.relationships.filter(
        (relationship): relationship is Extract<SemanticRelationshipRecordV1,
          { kind: "derived_from" }> =>
          relationship.kind === "derived_from" && relationship.fromFieldId === fromFieldId,
      );
      for (const relationship of existing) {
        if (!desired.has(relationship.toFieldId) && lastAction(relationship) !== "retire") {
          relationship.events.push({ v: 1, ...ref(operationIndex), action: "retire" });
        }
      }
      for (const toFieldId of desired) {
        let relationship = existing.find(candidate => candidate.toFieldId === toFieldId);
        if (!relationship) {
          relationship = {
            v: 1, kind: "derived_from", relationshipId: createRelationshipId(), origin,
            fromFieldId, toFieldId,
            events: [{ v: 1, ...ref(operationIndex), action: "activate" }],
          };
          table.semantic!.relationships.push(relationship);
        } else if (force || lastAction(relationship) !== "activate") {
          relationship.events.push({ v: 1, ...ref(operationIndex), action: "activate" });
        }
      }
    };

    // A store created before semantic metadata is upgraded without pretending
    // that its true introduction coordinates are known.
    for (const table of sim.values()) {
      if (!table.semantic) {
        table.semantic = {
          v: 1, tableId: createTableId(), label: table.name, aliases: [],
          origin: "legacy_backfill",
          events: [{ v: 1, version, operationIndex: 0,
            disposition: "legacy_unknown", origin: "legacy_backfill" }],
          relationships: [],
        };
      }
      table.columns.forEach((column, columnIndex) => {
        if (!column.semantic) column.semantic = {
          v: 1, fieldId: createFieldId(), label: column.name, aliases: [],
          origin: "legacy_backfill",
          events: [{ v: 1, version, operationIndex: 0,
            columnIndex, disposition: "legacy_unknown", origin: "legacy_backfill" }],
        };
        if (!table.inactive && !column.inactive)
          activateContains(table, column, 0, columnIndex);
      });
      for (const column of table.columns) {
        if (!table.inactive && !column.inactive && column.type === "computed" && column.expr)
          syncDerived(table, column, column.expr, 0);
      }
    }

    for (const [operationIndex, op] of (migration?.operations ?? []).entries()) {
      switch (op.op) {
        case "create_table": {
          const preserved = sim.get(op.table);
          let table: RegTable;
          const reactivated = preserved?.inactive === true;
          if (reactivated) {
            table = preserved;
            delete table.inactive;
            table.semantic!.events.push({
              v: 1, ...ref(operationIndex), disposition: "reactivate", origin,
            });
            for (const column of table.columns) column.inactive = true;
          } else {
            table = { name: op.table, columns: [],
              semantic: newTableSemantic(op.table, operationIndex, "introduce") };
            sim.set(op.table, table);
          }
          op.columns.forEach((spec, columnIndex) => {
            let column = table.columns.find(candidate => candidate.name === spec.name);
            const disposition = column?.inactive ? "reactivate" as const : "introduce" as const;
            if (column) {
              delete column.inactive;
              pushFieldEvent(column, operationIndex, disposition, columnIndex);
            } else {
              column = columnFrom(spec as Parameters<typeof columnFrom>[0]);
              column.semantic = newFieldSemantic(spec.name, operationIndex, disposition, columnIndex);
              table.columns.push(column);
            }
            activateContains(table, column, operationIndex, columnIndex, disposition === "reactivate");
          });
          for (const spec of op.columns) {
            const column = table.columns.find(candidate => candidate.name === spec.name)!;
            if (column.type === "computed" && column.expr)
              syncDerived(table, column, column.expr, operationIndex, reactivated);
          }
          break;
        }
        case "add_column": {
          const table = getTable(sim, op.table);
          let column = findStoredColumn(table, op.column.name);
          const disposition = column?.inactive ? "reactivate" as const : "introduce" as const;
          if (column) {
            delete column.inactive;
            pushFieldEvent(column, operationIndex, disposition);
          } else {
            column = columnFrom(op.column as Parameters<typeof columnFrom>[0]);
            column.semantic = newFieldSemantic(column.name, operationIndex, disposition);
            table.columns.push(column);
          }
          activateContains(table, column, operationIndex, undefined, disposition === "reactivate");
          if (column.type === "computed" && column.expr)
            syncDerived(table, column, column.expr, operationIndex, disposition === "reactivate");
          break;
        }
        case "create_computed": {
          const table = getTable(sim, op.table);
          let column = findStoredColumn(table, op.column);
          const disposition = column?.inactive ? "reactivate" as const : "introduce" as const;
          if (column) {
            delete column.inactive;
            pushFieldEvent(column, operationIndex, disposition);
          } else {
            column = { name: op.column, type: "computed", required: false, expr: op.expr,
              semantic: newFieldSemantic(op.column, operationIndex, disposition) };
            table.columns.push(column);
          }
          activateContains(table, column, operationIndex, undefined, disposition === "reactivate");
          syncDerived(table, column, op.expr, operationIndex, disposition === "reactivate");
          break;
        }
        case "rename_column": {
          const table = getTable(sim, op.table);
          const column = table.columns.find(candidate => candidate.name === op.from)!;
          pushFieldEvent(column, operationIndex);
          addAlias(column.semantic!.aliases, column.semantic!.label);
          column.name = op.to;
          column.semantic!.label = op.to;
          break;
        }
        case "update_computed": {
          const table = getTable(sim, op.table);
          const column = table.columns.find(candidate => candidate.name === op.column)!;
          pushFieldEvent(column, operationIndex);
          column.expr = op.expr;
          syncDerived(table, column, op.expr, operationIndex);
          break;
        }
        case "add_enum_value": {
          const column = getTable(sim, op.table).columns.find(candidate =>
            candidate.name === op.column)!;
          pushFieldEvent(column, operationIndex);
          column.values = [...(column.values ?? []), op.value];
          break;
        }
        case "hide_column": {
          const column = getTable(sim, op.table).columns.find(candidate =>
            candidate.name === op.column)!;
          pushFieldEvent(column, operationIndex); column.hidden = true;
          break;
        }
        case "set_required": {
          const column = getTable(sim, op.table).columns.find(candidate =>
            candidate.name === op.column)!;
          pushFieldEvent(column, operationIndex); column.required = true;
          break;
        }
        case "add_index":
        case "backfill": {
          const column = getTable(sim, op.table).columns.find(candidate =>
            candidate.name === op.column)!;
          pushFieldEvent(column, operationIndex);
          break;
        }
      }
    }

    const tables = new Map<string, TableId>();
    const fields = new Map<string, FieldId>();
    const relationships = new Map<string, ReturnType<typeof createRelationshipId>>();
    const tableSemantics = new Map<string, TableSemanticV1>();
    const fieldSemantics = new Map<string, FieldSemanticV1>();
    for (const table of sim.values()) {
      const semantic = table.semantic!;
      tables.set(table.name, semantic.tableId);
      tableSemantics.set(table.name, cloneTableSemantic(semantic));
      for (const column of table.columns) {
        fields.set(fieldKey(table.name, column.name), column.semantic!.fieldId);
        fieldSemantics.set(fieldKey(table.name, column.name),
          cloneFieldSemantic(column.semantic!));
      }
      for (const relationship of semantic.relationships) {
        const from = relationship.kind === "derived_from"
          ? relationship.fromFieldId : relationship.fromTableId;
        const to = relationship.kind === "contains"
          ? relationship.toFieldId
          : relationship.kind === "derived_from" ? relationship.toFieldId : relationship.toTableId;
        relationships.set(relationKey(relationship.kind, from, to), relationship.relationshipId);
      }
    }
    return {
      v: 1, version, origin, tables, fields, relationships,
      tableSemantics, fieldSemantics,
    };
  }

  private pruneSemanticAfter(version: number): void {
    for (const table of this.reg.values()) {
      if (!table.semantic) continue;
      table.semantic.events = table.semantic.events.filter(event => event.version <= version);
      for (const relationship of table.semantic.relationships)
        relationship.events = relationship.events.filter(event => event.version <= version);
      for (const column of table.columns) {
        if (column.semantic)
          column.semantic.events = column.semantic.events.filter(event => event.version <= version);
      }
    }
  }

  private alignSemanticLabelsToPhysicalShape(): void {
    for (const table of this.reg.values()) {
      if (table.semantic && table.semantic.label !== table.name) {
        if (!table.semantic.aliases.includes(table.semantic.label))
          table.semantic.aliases.push(table.semantic.label);
        table.semantic.label = table.name;
      }
      for (const column of table.columns) {
        if (!column.semantic || column.semantic.label === column.name) continue;
        if (!column.semantic.aliases.includes(column.semantic.label))
          column.semantic.aliases.push(column.semantic.label);
        column.semantic.label = column.name;
      }
    }
  }

  private persistRegistry(version: number): void {
    this.driver.exec("DELETE FROM sys.tables_registry");
    for (const t of this.reg.values()) {
      this.driver.exec(
        `INSERT INTO sys.tables_registry(table_name, version, spec_json, created_by, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [t.name, version, JSON.stringify(t), "kernel", nowIso()]);
    }
  }

  registrySnapshot(): Registry {
    return cloneActiveRegistry(this.reg);
  }

  /** Validator view includes inactive tombstones so a new plan cannot
   * collide with preserved physical data. Query resolution still treats
   * those tables and columns as unknown. */
  validationRegistrySnapshot(): Registry {
    return cloneRegistry(this.reg);
  }

  semanticSchemaTrace(): SemanticSchemaTraceV1 {
    const atVersion = this.currentVersion();
    this.ensureSemanticMetadata(atVersion, "legacy_backfill");
    const tables: Array<SemanticSchemaTraceV1["tables"][number]> = [];
    const fields: Array<SemanticSchemaTraceV1["fields"][number]> = [];
    const relationships: Array<SemanticSchemaTraceV1["relationships"][number]> = [];
    const opBindings: Array<SemanticSchemaTraceV1["opBindings"][number]> = [];
    for (const table of this.reg.values()) {
      const semantic = table.semantic!;
      tables.push({ tableId: semantic.tableId, conceptId: semantic.conceptId,
        name: table.name, label: semantic.label, aliases: [...semantic.aliases],
        state: table.inactive ? "inactive" : "visible" });
      semantic.events.filter(event => event.version <= atVersion)
        .forEach(event => opBindings.push({ ref: event,
        tableId: semantic.tableId, disposition: event.disposition, origin: event.origin }));
      for (const column of table.columns) {
        const field = column.semantic!;
        fields.push({ tableId: semantic.tableId, fieldId: field.fieldId,
          conceptId: field.conceptId, tableName: table.name, fieldName: column.name,
          label: field.label, aliases: [...field.aliases],
          state: table.inactive || column.inactive
            ? "inactive" : column.hidden ? "hidden" : "visible" });
        field.events.filter(event => event.version <= atVersion)
          .forEach(event => opBindings.push({ ref: event,
          tableId: semantic.tableId, fieldId: field.fieldId,
          disposition: event.disposition, origin: event.origin }));
      }
      for (const rel of semantic.relationships) {
        const target = rel.kind === "contains"
          ? table.columns.find(column => column.semantic?.fieldId === rel.toFieldId) : undefined;
        const fromField = rel.kind === "derived_from"
          ? table.columns.find(column => column.semantic?.fieldId === rel.fromFieldId)
          : rel.kind === "references"
            ? table.columns.find(column => column.semantic?.fieldId === rel.viaFieldId)
            : undefined;
        const toField = rel.kind === "derived_from"
          ? table.columns.find(column => column.semantic?.fieldId === rel.toFieldId) : undefined;
        const lifecycle = [...rel.events]
          .filter(event => event.version <= atVersion)
          .sort((left, right) => left.version - right.version
            || left.operationIndex - right.operationIndex
            || (left.columnIndex ?? -1) - (right.columnIndex ?? -1))
          .at(-1)?.action ?? (rel.baselineActive ? "activate" : "retire");
        const endpointInactive = target?.inactive || fromField?.inactive || toField?.inactive;
        const endpointHidden = target?.hidden || fromField?.hidden || toField?.hidden;
        relationships.push({ relationshipId: rel.relationshipId, kind: rel.kind,
          state: lifecycle === "retire" ? "retired"
            : table.inactive || endpointInactive ? "inactive"
              : endpointHidden ? "hidden" : "active",
          from: rel.kind === "derived_from" ? rel.fromFieldId : rel.fromTableId,
          to: rel.kind === "contains" ? rel.toFieldId
            : rel.kind === "derived_from" ? rel.toFieldId : rel.toTableId,
          ...(rel.kind === "references" ? { via: rel.viaFieldId } : {}),
        });
      }
    }
    return { v: 1, atVersion,
      tables: [...tables].sort((a, b) => a.name.localeCompare(b.name)),
      fields: [...fields].sort((a, b) => a.tableName.localeCompare(b.tableName)
        || a.fieldName.localeCompare(b.fieldName)),
      relationships: [...relationships], opBindings: [...opBindings] };
  }

  fieldProvenance(): FieldProvenance[] {
    this.ensureSemanticMetadata(this.currentVersion(), "legacy_backfill");
    const out: FieldProvenance[] = [];
    for (const table of this.reg.values()) {
      const tableId = table.semantic!.tableId;
      for (const column of table.columns) {
        const semantic = column.semantic!;
        const events = [...semantic.events].sort((a, b) =>
          a.version - b.version || a.operationIndex - b.operationIndex
          || (a.columnIndex ?? -1) - (b.columnIndex ?? -1));
        let derivation: FieldProvenance["derivation"];
        if (column.type === "computed" && column.expr) {
          const dependencies = [...exprFields(parseExpr(column.expr))]
            .map(name => table.columns.find(candidate => candidate.name === name)?.semantic?.fieldId)
            .filter((id): id is FieldId => id !== undefined);
          derivation = { expression: column.expr, dependencyFieldIds: dependencies };
        }
        out.push({ tableId, fieldId: semantic.fieldId,
          tableName: table.name, fieldName: column.name, fieldType: column.type,
          aliases: [...semantic.aliases], origin: semantic.origin,
          state: table.inactive || column.inactive
            ? "inactive" : column.hidden ? "hidden" : "visible",
          createdVersion: events[0]?.version ?? 0,
          lastChangedVersion: events.at(-1)?.version ?? 0,
          ...(derivation ? { derivation } : {}),
        });
      }
    }
    return out.sort((a, b) => a.tableName.localeCompare(b.tableName)
      || a.fieldName.localeCompare(b.fieldName));
  }

  recordPrivateMetric(event: PrivateMetricEvent): void {
    this.privateMetrics.record(event);
  }

  privateMetricsSummary(): PrivateMetricsSummary {
    return this.privateMetrics.summary();
  }

  setPrivateMetricsEnabled(enabled: boolean): void {
    this.privateMetrics.setCollectionEnabled(enabled);
  }

  clearPrivateMetrics(): void { this.privateMetrics.clear(); }

  // ---------- versions ----------
  headVersion(): number {
    const rows = this.driver.select("SELECT MAX(version) AS v FROM sys.version_log");
    return Number(rows[0]?.v ?? 0);
  }

  currentVersion(): number {
    const v = this.getSetting<number>("current_version");
    return v === undefined ? this.headVersion() : v;
  }

  private setCurrentVersion(v: number): void {
    this.setSetting("current_version", v);
  }

  // ---------- settings (doc 04 §3: mode, byo key, sample markers, …) ----------
  getSetting<T>(key: string): T | undefined {
    const rows = this.driver.select(
      "SELECT value_json FROM sys.settings WHERE key = ?", [key]);
    const raw = rows[0]?.value_json;
    return raw === undefined ? undefined : JSON.parse(String(raw)) as T;
  }

  setSetting(key: string, value: unknown): void {
    this.driver.exec(
      `INSERT INTO sys.settings(key, value_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      [key, JSON.stringify(value)]);
  }

  deleteSetting(key: string): void {
    this.driver.exec("DELETE FROM sys.settings WHERE key = ?", [key]);
  }

  scrubLegacyCredentialSettings(): void {
    const keys = [
      "byo_api_key", "anthropic_api_key", "openai_api_key", "api_key", "clay_session",
    ];
    this.driver.tx(() => {
      for (const key of keys) this.deleteSetting(key);
    });
  }

  getEntry(version: number): VersionEntry {
    const rows = this.driver.select(
      "SELECT * FROM sys.version_log WHERE version = ?", [version]);
    const r = rows[0];
    if (!r) throw new ClayError("E_VALIDATION", `no version ${version}`);
    const migration = r.migration_json === null
      ? null
      : {
          operations: JSON.parse(String(r.migration_json)) as MigrationPlanT["operations"],
          inverse: JSON.parse(String(r.inverse_json)) as MigrationPlanT["inverse"],
        };
    return {
      version: Number(r.version), parent: Number(r.parent),
      created_at: String(r.created_at), intent_text: String(r.intent_text),
      summary: String(r.summary), migration,
    };
  }

  private semanticOperationBounds(): SemanticOperationBounds {
    const bounds = new Map<number, readonly (number | null)[]>();
    for (const row of this.driver.select(
      "SELECT version, migration_json FROM sys.version_log WHERE migration_json IS NOT NULL",
    )) {
      let operations: MigrationPlanT["operations"];
      try {
        operations = JSON.parse(String(row.migration_json)) as MigrationPlanT["operations"];
      } catch {
        bounds.set(Number(row.version), []);
        continue;
      }
      bounds.set(Number(row.version), operations.map(operation =>
        operation.op === "create_table" ? operation.columns.length : null));
    }
    return bounds;
  }

  /** Commit a mutation: validate, migrate, write panel blobs/tombstones,
   * persist registry, append log — one transaction (doc 04 §4). */
  commit(input: CommitInput): number {
    const head = this.headVersion();
    if (this.currentVersion() !== head)
      throw new ClayError("E_VALIDATION",
        "store is rolled back (scrub preview); roll forward or truncate first");
    const semanticOrigin = input.semanticOrigin ?? "system";
    const semanticAssignments = input.semanticAssignments
      ?? this.prepareSemanticAssignments(input.migration, semanticOrigin);
    try {
      return this.driver.tx(() => {
        // capture the pre-commit manifest for the G16 rename rewrite
        const preLive = this.livePanels();
        const untouched = preLive.filter(p =>
          !(input.panels ?? []).some(np => np.panel_id === p.panel_id)
          && !(input.removePanels ?? []).includes(p.panel_id));
        // Layout size (ADR-017/018) is a direct-manipulation concern; a model
        // reshape re-emits placement WITHOUT w/h, so preserve the panel's
        // existing span AND height unless the plan explicitly sets one.
        const priorSize = new Map(preLive.map(p =>
          [p.panel_id, { w: p.placement.w, h: p.placement.h, col: p.placement.col }]));

        const version = head + 1;
        if (input.migration) {
          validateMigrationPlan(input.migration, this.reg);
          applyForwardOps(this.driver, this.reg, input.migration.operations);
        }
        this.ensureSemanticMetadata(
          version,
          semanticOrigin,
          semanticAssignments,
        );
        this.persistRegistry(version);
        this.driver.exec(
          `INSERT INTO sys.version_log(version, parent, created_at, intent_text,
             summary, diff_json, migration_json, inverse_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [version, head, nowIso(), input.intent, input.summary,
           JSON.stringify(input.diff ?? []),
           input.migration ? JSON.stringify(input.migration.operations) : null,
           input.migration ? JSON.stringify(input.migration.inverse) : null]);

        for (const p of input.panels ?? []) {
          const prior = priorSize.get(p.panel_id);
          const w = p.placement.w ?? prior?.w;   // undefined = default (half)
          const h = p.placement.h ?? prior?.h;
          const col = p.placement.col ?? prior?.col;
          const placement = { ...p.placement };
          if (w) placement.w = w; else delete placement.w;
          if (h) placement.h = h; else delete placement.h;
          if (col !== undefined) placement.col = col; else delete placement.col;
          this.writePanelBlob(version, { ...p, placement });
        }
        for (const id of input.removePanels ?? [])
          this.driver.exec(
            "INSERT INTO sys.panel_tombstones(version, panel_id) VALUES (?, ?)",
            [version, id]);

        // G16: untouched panels whose declared queries reference renamed
        // columns get a rewritten blob at this version. (Query literals
        // inside code are rewritten at the Bridge via the same map — the
        // static rewrite of code text is tracked as OPEN-QUESTIONS Q18.)
        const renames = (input.migration?.operations ?? [])
          .filter(o => o.op === "rename_column");
        if (renames.length > 0) {
          for (const lp of untouched) {
            let queries = lp.declared_queries;
            for (const r of renames)
              queries = queries.map(q => renameQueryFields(q, r.table, r.from, r.to));
            if (JSON.stringify(queries) !== JSON.stringify(lp.declared_queries))
              this.writePanelBlob(version, { ...lp, declared_queries: queries });
          }
        }

        this.setCurrentVersion(version);
        return version;
      });
    } catch (e) {
      this.loadRegistry();   // in-memory registry may be ahead of the rolled-back tx
      throw e;
    }
  }

  private writePanelBlob(version: number, p: PanelBlobInput): void {
    this.driver.exec(
      `INSERT OR REPLACE INTO sys.panel_blobs(version, panel_id, code,
         placement_json, declared_q_json) VALUES (?, ?, ?, ?, ?)`,
      [version, p.panel_id, p.code, JSON.stringify(p.placement),
       JSON.stringify({
         title: p.title,
         declared_queries: p.declared_queries,
         declared_writes: p.declared_writes,   // ADR-014 rides in the manifest json
       })]);
  }

  /**
   * Direct manipulation (B4/doc 13): apply new panel placements as a
   * reversible commit — no model, no migration. Only the moved panels are
   * re-committed (code and queries unchanged), so it's a normal version in
   * the log and fully rewindable via the time slider. Reshape by touch and
   * reshape by language share one history.
   */
  commitLayout(
    placements: { panel_id: string; region: "top" | "main" | "side"; order: number;
      w?: number; h?: number; col?: number | null }[],
  ): number {
    const live = new Map(this.livePanels().map(p => [p.panel_id, p]));
    const moved: PanelBlobInput[] = [];
    for (const pl of placements) {
      const p = live.get(pl.panel_id);
      if (!p) continue;
      // width/height/col default to current (preserved across reorder);
      // undefined width = default half (ADR-018). col:null clears the pin.
      const w = pl.w ?? p.placement.w;
      const h = pl.h ?? p.placement.h;
      const col = pl.col === null ? undefined : (pl.col ?? p.placement.col);
      if (p.placement.region === pl.region && p.placement.order === pl.order
        && p.placement.w === w && p.placement.h === h && p.placement.col === col) continue;
      const placement: PanelBlobInput["placement"] = { region: pl.region, order: pl.order };
      if (w) placement.w = w;
      if (h) placement.h = h;
      if (col !== undefined) placement.col = col;
      moved.push({
        panel_id: p.panel_id, title: p.title, placement,
        code: p.code, declared_queries: p.declared_queries, declared_writes: p.declared_writes,
      });
    }
    if (moved.length === 0) return this.headVersion();
    return this.commit({
      intent: "rearrange layout",
      summary: "Rearranged the layout by hand.",
      migration: null, semanticOrigin: "direct", panels: moved,
      diff: moved.map(p => ({
        kind: "change_panel",
        detail: `Moved ${p.title} to ${p.placement.region}`,
      })),
    });
  }

  /** Direct manipulation (ADR-022c): rename one panel's title as a
   * reversible commit — no model. Small changes must never need a prompt
   * round-trip. Same commit vocabulary as a plan's change_panel. */
  renamePanel(panelId: string, title: string): number {
    const p = this.livePanels().find(x => x.panel_id === panelId);
    if (!p) throw new ClayError("E_VALIDATION", `no live panel '${panelId}'`);
    const next = title.trim().slice(0, 80);
    if (next.length === 0)
      throw new ClayError("E_VALIDATION", "panel title cannot be empty");
    if (next === p.title) return this.headVersion();
    return this.commit({
      intent: `rename the ${p.title} panel`,
      summary: `Renamed “${p.title}” to “${next}”.`,
      migration: null, semanticOrigin: "direct",
      panels: [{
        panel_id: p.panel_id, title: next, placement: p.placement,
        code: p.code, declared_queries: p.declared_queries, declared_writes: p.declared_writes,
      }],
      diff: [{ kind: "change_panel", detail: `Renamed ${p.title} to ${next}` }],
    });
  }

  /** Direct manipulation (ADR-022c): remove one panel as a reversible
   * commit (tombstone). Data rows are untouched — rewind the timeline to
   * bring the panel back. Same vocabulary as a plan's remove_panels. */
  removePanel(panelId: string): number {
    const p = this.livePanels().find(x => x.panel_id === panelId);
    if (!p) throw new ClayError("E_VALIDATION", `no live panel '${panelId}'`);
    return this.commit({
      intent: `remove the ${p.title} panel`,
      summary: `Removed the “${p.title}” panel.`,
      migration: null, semanticOrigin: "direct", removePanels: [panelId],
      diff: [{ kind: "remove_panel", detail: `Removed ${p.title}` }],
    });
  }

  /** Live panels at a version (default: current): latest blob per id, minus
   * panels whose latest tombstone is newer than their latest blob
   * (doc 04 §5). Passing an older version powers scrub-preview — panels AT
   * K rendered against CURRENT data, no inverses run (doc 02 §6). */
  livePanels(at?: number): LivePanel[] {
    const v = at ?? this.currentVersion();
    const rows = this.driver.select(
      `SELECT b.panel_id, b.version, b.code, b.placement_json, b.declared_q_json
       FROM sys.panel_blobs b
       JOIN (SELECT panel_id, MAX(version) AS mv FROM sys.panel_blobs
             WHERE version <= ? GROUP BY panel_id) m
         ON b.panel_id = m.panel_id AND b.version = m.mv
       ORDER BY b.panel_id`, [v, ]);
    const out: LivePanel[] = [];
    for (const r of rows) {
      const tomb = this.driver.select(
        `SELECT MAX(version) AS tv FROM sys.panel_tombstones
         WHERE panel_id = ? AND version <= ?`, [String(r.panel_id), v]);
      const tv = tomb[0]?.tv;
      if (tv !== null && tv !== undefined && Number(tv) >= Number(r.version)) continue;
      const manifest = JSON.parse(String(r.declared_q_json)) as {
        title: string; declared_queries: QueryT[]; declared_writes: string[];
      };
      out.push({
        panel_id: String(r.panel_id), version: Number(r.version),
        code: String(r.code),
        placement: JSON.parse(String(r.placement_json)) as LivePanel["placement"],
        title: manifest.title,
        declared_queries: manifest.declared_queries,
        declared_writes: manifest.declared_writes ?? [],
      });
    }
    return out;
  }

  /** Read-only provenance for a panel, derived from the existing blob and
   * version logs. Old apps gain it immediately without a new metadata table. */
  panelProvenance(panelId: string, at?: number): PanelProvenance | null {
    const version = at ?? this.currentVersion();
    const removed = this.driver.select(
      `SELECT MAX(version) AS removed_version FROM sys.panel_tombstones
       WHERE panel_id = ? AND version <= ?`,
      [panelId, version],
    )[0]?.removed_version;
    const afterVersion = removed == null ? 0 : Number(removed);
    const row = this.driver.select(
      `SELECT MIN(version) AS created_version, MAX(version) AS changed_version
       FROM sys.panel_blobs WHERE panel_id = ? AND version > ? AND version <= ?`,
      [panelId, afterVersion, version],
    )[0];
    if (row?.created_version == null || row.changed_version == null) return null;
    const createdVersion = Number(row.created_version);
    const lastChangedVersion = Number(row.changed_version);
    const created = this.getEntry(createdVersion);
    const changed = this.getEntry(lastChangedVersion);
    return {
      panel_id: panelId,
      createdVersion,
      lastChangedVersion,
      createdAt: created.created_at,
      lastChangedAt: changed.created_at,
      createdIntent: created.intent_text,
      lastChangedIntent: changed.intent_text,
      createdSummary: created.summary,
      lastChangedSummary: changed.summary,
    };
  }

  /** The full linear chain, oldest first (history view / time slider).
   * Joins any user-set checkpoint label (named moments on the timeline). */
  history(): HistoryEntry[] {
    return this.driver.select(
      `SELECT v.version, v.parent, v.created_at, v.intent_text, v.summary, v.diff_json, c.label
       FROM sys.version_log v
       LEFT JOIN sys.checkpoints c ON c.version = v.version
       ORDER BY v.version`).map(r => ({
      version: Number(r.version), parent: Number(r.parent),
      created_at: String(r.created_at), intent_text: String(r.intent_text),
      summary: String(r.summary),
      ...(r.label != null ? { label: String(r.label) } : {}),
      ...(r.diff_json != null ? { diff: parseDiff(String(r.diff_json)) } : {}),
    }));
  }

  /** Name a moment on the timeline (checkpoint). Empty label clears it.
   * Labels live in sys, never in the data substrate (P1). */
  setCheckpoint(version: number, label: string): void {
    const trimmed = label.trim().slice(0, 60);
    if (trimmed === "") {
      this.driver.exec("DELETE FROM sys.checkpoints WHERE version = ?", [version]);
      return;
    }
    this.driver.exec(
      `INSERT INTO sys.checkpoints(version, label, created_at) VALUES (?, ?, ?)
       ON CONFLICT(version) DO UPDATE SET label = excluded.label`,
      [version, trimmed, nowIso()]);
  }

  /** Last n commit summaries, newest first (S1 context, doc 05 §1). */
  recentSummaries(n: number): string[] {
    return this.driver
      .select("SELECT summary FROM sys.version_log ORDER BY version DESC LIMIT ?", [n])
      .map(r => String(r.summary));
  }

  // ---------- attempts (S0/doc 05 §5 analytics) ----------
  beginAttempt(intent: string): string {
    const id = uuidv7();
    this.driver.exec(
      "INSERT INTO sys.attempts(id, at, intent_text, outcome, error_code) VALUES (?, ?, ?, 'pending', NULL)",
      [id, nowIso(), intent]);
    return id;
  }

  finishAttempt(id: string, outcome: string, errorCode: string | null = null): void {
    this.driver.exec(
      "UPDATE sys.attempts SET outcome = ?, error_code = ? WHERE id = ?",
      [outcome, errorCode, id]);
  }

  /** Independent full copy for the S4 shadow dry-run (doc 05 §1). */
  async shadowCopy(): Promise<ClayStore> {
    const copy = new ClayStore(await this.driver.snapshot());
    copy.loadRegistry();
    return copy;
  }

  /** Apply inverses current..K+1. With truncate, the chain above K is discarded. */
  rollbackTo(target: number, opts: { truncate?: boolean } = {}): void {
    const cur = this.currentVersion();
    if (target < 0 || target >= cur)
      throw new ClayError("E_VALIDATION", `cannot roll back from ${cur} to ${target}`);
    try {
      this.driver.tx(() => {
        for (let v = cur; v > target; v--) {
          const entry = this.getEntry(v);
          if (entry.migration)
            applyInverseOps(this.driver, this.reg, entry.migration.inverse);
        }
        this.alignSemanticLabelsToPhysicalShape();
        this.persistRegistry(target);
        if (opts.truncate) {
          this.driver.exec("DELETE FROM sys.version_log WHERE version > ?", [target]);
          this.driver.exec("DELETE FROM sys.panel_blobs WHERE version > ?", [target]);
          this.driver.exec("DELETE FROM sys.panel_tombstones WHERE version > ?", [target]);
          this.driver.exec("DELETE FROM sys.checkpoints WHERE version > ?", [target]);
          this.pruneSemanticAfter(target);
          this.persistRegistry(target);
        }
        this.setCurrentVersion(target);
      });
    } catch (e) {
      this.loadRegistry();
      throw e;
    }
  }

  /** Re-apply forward ops current+1..N (only meaningful before truncation). */
  rollForwardTo(target: number): void {
    const cur = this.currentVersion();
    const head = this.headVersion();
    if (target <= cur || target > head)
      throw new ClayError("E_VALIDATION", `cannot roll forward from ${cur} to ${target} (head ${head})`);
    try {
      this.driver.tx(() => {
        for (let v = cur + 1; v <= target; v++) {
          const entry = this.getEntry(v);
          if (entry.migration)
            applyForwardOps(this.driver, this.reg, entry.migration.operations);
        }
        this.alignSemanticLabelsToPhysicalShape();
        this.persistRegistry(target);
        this.setCurrentVersion(target);
      });
    } catch (e) {
      this.loadRegistry();
      throw e;
    }
  }

  // ---------- rows ----------
  insert(table: string, row: Record<string, unknown>): QueryRow {
    const t = getTable(this.reg, table);
    const { cols, vals } = validateInsert(t, row);
    const id = uuidv7();
    const now = nowIso();
    const allCols = ["id", "created_at", "updated_at", ...cols];
    const allVals: SqlValue[] = [id, now, now, ...vals];
    this.driver.tx(() => {
      this.driver.exec(
        `INSERT INTO ${qid(table)} (${allCols.map(qid).join(", ")})
         VALUES (${allCols.map(() => "?").join(", ")})`, allVals);
      for (const column of t.columns) {
        if (!column.inactive || column.type === "computed") continue;
        this.driver.exec(
          `INSERT OR IGNORE INTO sys.inactive_cells(table_name, column_name, row_id)
           VALUES (?, ?, ?)`, [table, column.name, id]);
      }
    });
    this.observer.record({ kind: "insert", subject: table });
    return this.rowById(table, id);
  }

  // ---------- Observer (doc 02 §1) ----------
  recordUsage(ev: UsageEvent): void { this.observer.record(ev); }
  suggestions(): Suggestion[] {
    // tables that already have at least one panel — so "table with data but
    // no view" can be offered (ambient reshaping, B3).
    const viewed = new Set<string>();
    const boarded = new Set<string>();          // tables already shown as a board
    const flowed = new Set<string>();           // ... or as a workflow (ADR-027)
    const charted = new Set<string>();          // ... or summarised in a chart
    for (const p of this.livePanels()) {
      const code = p.code ?? "";
      const isBoard = /\bBoard\b/.test(code);
      const isFlow = /\bFlow\b/.test(code);
      const isChart = /\bChart\b/.test(code);
      for (const q of p.declared_queries) {
        viewed.add(q.from);
        if (isBoard) boarded.add(q.from);
        if (isFlow) flowed.add(q.from);
        if (isChart) charted.add(q.from);
      }
    }
    return this.observer.suggestions(this.registrySnapshot(), viewed, boarded, flowed, charted);
  }
  markSuggestionShown(subject: string, kind: string): void {
    this.observer.markShown(subject, kind);
  }
  dismissSuggestion(subject: string, kind: string): void {
    this.observer.dismiss(subject, kind);
  }
  acceptSuggestion(subject: string, kind: string): void {
    this.observer.accept(subject, kind);
  }

  /** G6: snapshot the raw row before every update/softDelete. */
  private writeRowHistory(table: string, id: string): void {
    const rows = this.driver.select(
      `SELECT * FROM ${qid(table)} WHERE "id" = ?`, [id]);
    if (!rows[0]) return;
    this.driver.exec(
      `INSERT INTO "row_history"("id", "table", "row_id", "at", "before_json")
       VALUES (?, ?, ?, ?, ?)`,
      [uuidv7(), table, id, nowIso(), JSON.stringify(rows[0])]);
    const n = Number(this.driver.select(
      `SELECT COUNT(*) AS n FROM "row_history"`)[0]?.n ?? 0);
    if (n > this.rowHistoryCap) {
      this.driver.exec(
        `DELETE FROM "row_history" WHERE "id" IN (
           SELECT "id" FROM "row_history" ORDER BY "at" ASC LIMIT ?)`,
        [n - this.rowHistoryCap]);
    }
  }

  rowHistoryCount(): number {
    return Number(this.driver.select(
      `SELECT COUNT(*) AS n FROM "row_history"`)[0]?.n ?? 0);
  }

  /** Local attempt stats for Settings (doc 05 §5). No network. */
  attemptStats(): { kept: number; discarded: number; failed: number; clarify: number } {
    const rows = this.driver.select(
      `SELECT outcome, COUNT(*) AS n FROM sys.attempts GROUP BY outcome`);
    const by = (o: string): number =>
      Number(rows.find(r => r.outcome === o)?.n ?? 0);
    return { kept: by("kept"), discarded: by("discarded"),
      failed: by("failed"), clarify: by("clarify") };
  }

  /** Rows with a snapshot in the restore window (G6: last 30 days). */
  restorableRows(table: string, sinceDays = 30): string[] {
    getTable(this.reg, table);
    const cutoff = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
    return this.driver.select(
      `SELECT DISTINCT "row_id" FROM "row_history" WHERE "table" = ? AND "at" >= ?`,
      [table, cutoff]).map(r => String(r.row_id));
  }

  /** A row's snapshots, newest first (ADR-027: the Data view shows each
   * record's own history). Read-only; values are the row AS IT WAS before
   * each change, projected onto columns that still exist. Trusted-shell
   * surface only — never exposed to panel queries (row_history stays a
   * reserved table name). */
  rowHistory(table: string, id: string, limit = 20):
    { at: string; values: Record<string, unknown> }[] {
    const t = getTable(this.reg, table);
    const live = new Set(t.columns.filter(c => !c.inactive).map(c => c.name));
    return this.driver.select(
      `SELECT "at", "before_json" FROM "row_history"
       WHERE "table" = ? AND "row_id" = ? ORDER BY "at" DESC LIMIT ?`,
      [table, id, limit]).map(r => {
      const raw = JSON.parse(String(r.before_json)) as Record<string, unknown>;
      const values: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw)) if (live.has(k)) values[k] = v;
      return { at: String(r.at), values };
    });
  }

  /** Restore the most recent snapshot of a row (also undeletes, since the
   * snapshot carries deleted_at). Columns that no longer exist are skipped
   * — a projection, not a loss (doc 04 §5 spirit). */
  restoreRow(table: string, id: string): QueryRow {
    const t = getTable(this.reg, table);
    const entry = this.driver.select(
      `SELECT "before_json" FROM "row_history"
       WHERE "table" = ? AND "row_id" = ? ORDER BY "at" DESC LIMIT 1`,
      [table, id])[0];
    if (!entry)
      throw new ClayError("E_VALIDATION", `no history for '${table}/${id}'`);
    this.mustExist(table, id);
    const before = JSON.parse(String(entry.before_json)) as Record<string, SqlValue>;
    const settable = new Set([
      ...t.columns.filter(c => c.type !== "computed" && !c.inactive).map(c => c.name),
      "deleted_at",
    ]);
    const cols = Object.keys(before).filter(k => settable.has(k));
    if (cols.length > 0) {
      this.writeRowHistory(table, id);   // restoring is itself undoable
      this.driver.exec(
        `UPDATE ${qid(table)} SET ${cols.map(c => `${qid(c)} = ?`).join(", ")},
           "updated_at" = ? WHERE "id" = ?`,
        [...cols.map(c => before[c] ?? null), nowIso(), id]);
    }
    return this.rowById(table, id);
  }

  update(table: string, id: string, patch: Record<string, unknown>): QueryRow {
    const t = getTable(this.reg, table);
    this.mustExist(table, id);
    this.writeRowHistory(table, id);
    const { cols, vals } = validatePatch(t, patch);
    this.driver.exec(
      `UPDATE ${qid(table)} SET ${cols.map(c => `${qid(c)} = ?`).join(", ")},
         "updated_at" = ? WHERE "id" = ?`,
      [...vals, nowIso(), id]);
    return this.rowById(table, id);
  }

  softDelete(table: string, id: string): void {
    getTable(this.reg, table);
    this.mustExist(table, id);
    this.writeRowHistory(table, id);
    this.driver.exec(
      `UPDATE ${qid(table)} SET "deleted_at" = ?, "updated_at" = ? WHERE "id" = ?`,
      [nowIso(), nowIso(), id]);
  }

  query(q: QueryT, now: Date = new Date()): QueryRow[] {
    return runQuery(this.driver, this.reg, q, now);
  }

  private mustExist(table: string, id: string): void {
    const rows = this.driver.select(
      `SELECT "id" FROM ${qid(table)} WHERE "id" = ?`, [id]);
    if (rows.length === 0)
      throw new ClayError("E_VALIDATION", `no row '${id}' in '${table}'`);
  }

  private rowById(table: string, id: string): QueryRow {
    const rows = runQuery(this.driver, this.reg,
      { from: table, where: [{ field: "id", op: "eq", value: id }], includeDeleted: true });
    const row = rows[0];
    if (!row) throw new ClayError("E_INTERNAL", "row vanished after write");
    return row;
  }

  /** Panel-scoped revert (doc 05 §7): restore the PREVIOUS blob of one
   * panel as a NEW commit — linear history preserved, nothing truncated. */
  revertPanel(panelId: string): number {
    const current = this.livePanels().find(p => p.panel_id === panelId);
    if (!current)
      throw new ClayError("E_VALIDATION", `no live panel '${panelId}'`);
    const rows = this.driver.select(
      `SELECT version, code, placement_json, declared_q_json FROM sys.panel_blobs
       WHERE panel_id = ? AND version < ? ORDER BY version DESC LIMIT 1`,
      [panelId, current.version]);
    const prev = rows[0];
    if (!prev)
      throw new ClayError("E_VALIDATION",
        `'${panelId}' has no earlier version to roll back to`);
    const manifest = JSON.parse(String(prev.declared_q_json)) as {
      title: string; declared_queries: QueryT[]; declared_writes?: string[];
    };
    return this.commit({
      intent: `roll back panel ${panelId}`,
      summary: `Rolls back the ${manifest.title} panel to its previous version.`,
      migration: null,
      panels: [{
        panel_id: panelId, title: manifest.title,
        placement: JSON.parse(String(prev.placement_json)) as LivePanel["placement"],
        code: String(prev.code),
        declared_queries: manifest.declared_queries,
        declared_writes: manifest.declared_writes ?? [],
      }],
      diff: [{ kind: "change_panel", detail: `${manifest.title} rolled back` }],
    });
  }

  /** Raw physical dump, ordered by id — bit-equality checks (PB1, spine). */
  dumpTable(table: string): SqlRow[] {
    getTable(this.reg, table);
    return this.driver.select(`SELECT * FROM ${qid(table)} ORDER BY "id"`);
  }

  // ---------- .clay archives (doc 04 §7) ----------
  /** zip{ manifest.json, user.db, system.db } — the backup story and a
   * trust artifact: the whole app in one file. */
  async exportArchive(appName: string): Promise<Uint8Array> {
    this.scrubLegacyCredentialSettings();
    const { user, system } = await this.driver.exportDatabases();
    const manifest: ClayManifest = {
      format: 3, app: appName, exported_at: nowIso(),
      tables: this.registrySnapshot().size, versions: this.headVersion(),
    };
    return zipWrite([
      { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) },
      { name: "user.db", data: user },
      { name: "system.db", data: system },
    ]);
  }

  static parseArchive(bytes: Uint8Array): {
    manifest: ClayManifest; user: Uint8Array; system: Uint8Array;
  } {
    const entries = zipRead(bytes);
    const get = (name: string): Uint8Array => {
      const e = entries.find(x => x.name === name);
      if (!e) throw new ClayError("E_VALIDATION", `archive is missing ${name}`);
      return e.data;
    };
    const manifest = JSON.parse(new TextDecoder().decode(get("manifest.json"))) as ClayManifest;
    if (manifest.format !== 1 && manifest.format !== 2 && manifest.format !== 3)
      throw new ClayError("E_VALIDATION",
        `unsupported archive format ${String(manifest.format)}`);
    return { manifest, user: get("user.db"), system: get("system.db") };
  }

  /** Integrity checks run on an import staging store (doc 04 §7). */
  verifyIntegrity(manifest?: ClayManifest): string[] {
    const issues: string[] = [...semanticRegistryIssues(
      this.reg, this.headVersion(), this.semanticOperationBounds(),
    )];
    const registryNames = new Set(this.reg.keys());
    const physicalTables = new Set(this.driver.select(
      `SELECT name FROM main.sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'row_history'`,
    ).map(row => String(row.name)));
    for (const table of physicalTables)
      if (!registryNames.has(table)) issues.push(`physical table '${table}' is not registered`);
    for (const row of this.driver.select(
      "SELECT table_name, spec_json FROM sys.tables_registry",
    )) {
      try {
        const spec = JSON.parse(String(row.spec_json)) as { name?: unknown };
        if (spec.name !== row.table_name)
          issues.push(`registry key '${String(row.table_name)}' does not match its spec name`);
      } catch { issues.push(`registry row '${String(row.table_name)}' is not valid JSON`); }
    }
    if (manifest) {
      if (manifest.tables !== this.reg.size)
        issues.push(`manifest table count ${manifest.tables} does not match registry ${this.reg.size}`);
      if (manifest.versions !== this.headVersion())
        issues.push(`manifest version count ${manifest.versions} does not match head ${this.headVersion()}`);
    }
    for (const t of this.reg.values()) {
      const info = this.driver.select(`PRAGMA main.table_info(${qid(t.name)})`);
      const physical = new Set(info.map(r => String(r.name)));
      if (physical.size === 0) { issues.push(`table '${t.name}' is missing`); continue; }
      for (const col of ["id", "created_at", "updated_at", "deleted_at"])
        if (!physical.has(col)) issues.push(`'${t.name}' lacks kernel column '${col}'`);
      for (const c of t.columns)
        if (c.type !== "computed" && !physical.has(c.name))
          issues.push(`'${t.name}' lacks registered column '${c.name}'`);
      const registered = new Set([
        "id", "created_at", "updated_at", "deleted_at",
        ...t.columns.filter(c => c.type !== "computed").map(c => c.name),
      ]);
      for (const column of physical)
        if (!registered.has(column))
          issues.push(`'${t.name}' has unregistered physical column '${column}'`);
    }
    const markers=this.driver.select("SELECT table_name,column_name,row_id FROM sys.inactive_cells");
    for(const m of markers){
      const t=this.reg.get(String(m.table_name));
      const c=t&&findStoredColumn(t,String(m.column_name));
      if(!t||!c?.inactive){issues.push("inactive-cell marker has no inactive column");continue;}
      const r=this.driver.select(`SELECT ${qid(c.name)} AS v FROM ${qid(t.name)} WHERE "id"=?`,[String(m.row_id)]);
      if(r.length!==1||r[0]?.v!==null)issues.push("inactive-cell marker does not point to a NULL cell");
    }
    const chain = this.history();
    chain.forEach((e, i) => {
      if (e.version !== i + 1 || e.parent !== i)
        issues.push(`version chain broken at v${e.version}`);
    });
    try { this.livePanels(); }
    catch (e) { issues.push(`panel manifest unreadable: ${String(e)}`); }
    return issues;
  }

  /**
   * Import an archive: stage in memory, run integrity checks (abort on
   * failure — the live app is untouched), re-validate every live panel
   * blob (G15: never execute unvalidated blobs, regardless of provenance),
   * then swap. With `openFresh` the staged content is copied into a fresh
   * (persistent) driver; without it the staging store IS the result.
   */
  static async importArchive(
    bytes: Uint8Array,
    openFresh?: () => Promise<DbDriver>,
  ): Promise<{ store: ClayStore; manifest: ClayManifest; invalidPanels: string[] }> {
    const { manifest, user, system } = ClayStore.parseArchive(bytes);
    const staging = ClayStore.fromDriver(
      await openDriverFromBytes(user, system),
      { requireSemanticRegistry: manifest.format === 3 },
    );
    try {
      staging.scrubLegacyCredentialSettings();
      const issues = staging.verifyIntegrity(manifest.format === 3 ? manifest : undefined);
      if (issues.length > 0)
        throw new ClayError("E_VALIDATION",
          `archive failed integrity checks: ${issues.join("; ")}`, issues);

      const invalidPanels: string[] = [];
      for (const panel of staging.livePanels()) {
        const problems = validateMutationPlan({
          api: 1, summary: "Imported panel.",
          user_facing_diff: [{ kind: "add_panel", detail: panel.panel_id }],
          clarifying_question: null, assumptions: [], migration: null,
          panels: [{
            panel_id: panel.panel_id, title: panel.title,
            placement: panel.placement, code: panel.code,
            declared_queries: panel.declared_queries,
            declared_writes: panel.declared_writes,
          }],
          remove_panels: [], confidence: 1,
        }, { registry: staging.registrySnapshot(), livePanelIds: [] });
        if (problems.length > 0) invalidPanels.push(panel.panel_id);
      }

      if (!openFresh) return { store: staging, manifest, invalidPanels };
      const fresh = await openFresh();
      copyDatabase(staging.driver, fresh);
      staging.close();
      return { store: ClayStore.fromDriver(fresh), manifest, invalidPanels };
    } catch (e) {
      staging.close();
      throw e;
    }
  }
}

export type ClayManifest = {
  /** v2 adds rollback tombstones; v3 requires the semantic registry. */
  format: 1 | 2 | 3;
  app: string;
  exported_at: string;
  tables: number;
  versions: number;
};
