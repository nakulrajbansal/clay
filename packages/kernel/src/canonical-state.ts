import { SYSTEM_TABLES, type DbDriver, type SqlRow } from "./db";
import { isLegacyCredentialSettingKey } from "./credential-policy";
import { ClayError } from "./errors";
import { userIndexAuthorities } from "./index-authority";
import { parseClosedMainTableSql } from "./main-schema-grammar";
import { isVirtualColumn, type RegColumn, type Registry } from "./registry";
import { isFieldId, isTableId } from "./semantic";
import { sha256HexSync } from "./state-digest";
import { canonicalIntegerKeyV1, canonicalTextKeyV1 } from "./state-key";
import { stateLeafHashV1, stateRootV1, type StateLeafFieldV1 } from "./state-merkle";
import { StateMerkleIndex, type StateMerkleSeed } from "./state-merkle-index";
import { canonicalContentFieldV1, canonicalSqlFieldV1 } from "./state-sql-canonical";

const SAFE_TABLE = /^[a-z][a-z0-9_]{0,40}$|^__(?:clay_attachments)$/;
const SAFE_INDEX = /^idx_[a-z][a-z0-9_]{0,40}_[a-z][a-z0-9_]{0,40}$/;
const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTENT_SHA = /^[0-9a-f]{64}$/;
const RAW_TEXT_HEX = /^(?:[0-9A-F]{2})*$/;
const SQLITE_TYPE = /^(?:TEXT|INTEGER|REAL|BLOB)$/i;
const schemaTextEncoder = new TextEncoder();
const rawTextDecoder = new TextDecoder("utf-8", { fatal: true });
const MAIN_INDEX_SQL = {
  idx_row_history_batch: 'CREATE INDEX "idx_row_history_batch" ON "row_history"("batch_id")',
  idx_row_history_sequence: 'CREATE UNIQUE INDEX "idx_row_history_sequence" ON "row_history"("sequence")',
} as const;
const SYSTEM_INDEX_SQL = {
  idx_automation_runs_rule: "CREATE INDEX idx_automation_runs_rule ON automation_runs(automation_id, at)",
  idx_record_events_table_seq: "CREATE INDEX idx_record_events_table_seq ON record_events(table_name, seq)",
} as const;
const MERKLE_INDEX_SQL = "CREATE INDEX idx_state_digest_leaves_bucket ON state_digest_leaves(bucket, leaf_key)";
const EXCLUDED_SYSTEM_TABLES = ["private_metric_state", "private_metric_daily"] as const;
const MERKLE_SYSTEM_TABLES = [
  "state_digest_leaves", "state_digest_buckets", "state_digest_root",
] as const;
const TARGET_AUTHORITY_SYSTEM_TABLES = [
  "target_authority_header", "target_revision_reservations",
] as const;
const STORAGE_TYPE: Record<RegColumn["type"], string | null> = {
  text: "TEXT", number: "REAL", integer: "INTEGER", boolean: "INTEGER",
  date: "TEXT", enum: "TEXT", json: "TEXT", computed: null,
  relation: "TEXT", lookup: null, rollup: null, rich_text: "TEXT", attachment: "TEXT",
};
const KERNEL_COLUMNS = [
  { name: "id", type: "TEXT" },
  { name: "created_at", type: "TEXT" },
  { name: "updated_at", type: "TEXT" },
  { name: "deleted_at", type: "TEXT" },
] as const;

export type CanonicalStateLeafEntryV1 = {
  source: { database: "main" | "sys"; table: string };
  seed: StateMerkleSeed;
};

export type CanonicalStateEnumerationV1 = {
  schema: 1;
  coverage: Array<{ database: "main" | "sys"; table: string; rowCount: number }>;
  leaves: CanonicalStateLeafEntryV1[];
  stateSha256: string;
};

type Column = {
  name: string; type: string; pk: number; cid: number;
  hidden: number; notnull: number; defaultValue: string | null;
};

function invalid(message = "canonical target-state enumeration failed"): ClayError {
  return new ClayError("E_STATE_DIGEST_INVALID", message);
}

function qid(name: string): string {
  if (!SAFE_TABLE.test(name)) throw invalid();
  return `"${name}"`;
}

function qindex(name: string): string {
  if (!SAFE_INDEX.test(name)) throw invalid();
  return `"${name}"`;
}

function validateRawText(value: unknown, hex: unknown): string {
  if (typeof value !== "string" || typeof hex !== "string" || !RAW_TEXT_HEX.test(hex))
    throw invalid("SQLite text bytes are invalid");
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++)
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  try {
    if (rawTextDecoder.decode(bytes) !== value) throw invalid("SQLite text bytes are invalid");
  } catch {
    throw invalid("SQLite text bytes are invalid");
  }
  return value;
}

function columns(driver: DbDriver, database: "main" | "sys", table: string): Column[] {
  const rows = driver.select(
    `SELECT name, type, pk, cid, hidden, "notnull" AS required, dflt_value,
            hex(CAST(name AS BLOB)) AS name_hex,
            hex(CAST(type AS BLOB)) AS type_hex,
            hex(CAST(dflt_value AS BLOB)) AS default_hex
     FROM pragma_table_xinfo(?,?) ORDER BY cid`,
    [table, database],
  );
  if (rows.length === 0) throw invalid();
  return rows.map(row => {
    const name = validateRawText(row.name, row.name_hex);
    const rawType = validateRawText(row.type, row.type_hex);
    if (!(table === "sqlite_sequence" && rawType === "") && !SQLITE_TYPE.test(rawType))
      throw invalid("SQLite declared type is invalid");
    const pk = Number(row.pk);
    const cid = Number(row.cid);
    const hidden = Number(row.hidden);
    const notnull = Number(row.required);
    let defaultValue: string | null;
    if (row.dflt_value === null) defaultValue = null;
    else defaultValue = validateRawText(row.dflt_value, row.default_hex);
    if (!Number.isSafeInteger(pk) || pk < 0
        || !Number.isSafeInteger(cid) || cid < 0 || hidden !== 0
        || (notnull !== 0 && notnull !== 1)) throw invalid();
    return {
      name, type: rawType.toUpperCase(), pk, cid, hidden, notnull, defaultValue,
    };
  });
}

export function canonicalTableSchemaFieldsV1(
  driver: DbDriver,
  database: "main" | "sys",
  table: string,
): StateLeafFieldV1[] {
  const schemaRows = driver.select(
    `SELECT sql, hex(CAST(sql AS BLOB)) AS sql_hex FROM ${database}.sqlite_master
     WHERE type = 'table' AND name = ?`, [table],
  );
  if (schemaRows.length !== 1) throw invalid("table schema is unavailable");
  const schemaSql = validateRawText(schemaRows[0]!.sql, schemaRows[0]!.sql_hex);
  const tableColumns = columns(driver, database, table);
  if (database === "main") {
    const declarations = parseClosedMainTableSql(schemaSql, table);
    if (declarations.length !== tableColumns.length
        || declarations.some((declaration, index) => {
          const column = tableColumns[index]!;
          return declaration.name !== column.name || declaration.type !== column.type
            || Number(declaration.primaryKey) !== column.pk
            || Number(declaration.notnull) !== column.notnull
            || column.defaultValue !== null || column.hidden !== 0;
        })) throw invalid("main table schema does not match physical metadata");
  }
  const fields: StateLeafFieldV1[] = database === "sys"
    ? [canonicalSqlFieldV1("trusted_sql_sha256", "TEXT",
      `sha256:${sha256HexSync(schemaTextEncoder.encode(schemaSql))}`)]
    : [];
  for (const column of tableColumns) {
    const prefix = `column/${column.cid}`;
    fields.push(
      canonicalSqlFieldV1(`${prefix}/name`, "TEXT", column.name),
      canonicalSqlFieldV1(`${prefix}/type`, "TEXT", column.type),
      canonicalSqlFieldV1(`${prefix}/notnull`, "INTEGER", column.notnull),
      canonicalSqlFieldV1(`${prefix}/pk`, "INTEGER", column.pk),
      canonicalSqlFieldV1(`${prefix}/hidden`, "INTEGER", column.hidden),
      canonicalSqlFieldV1(`${prefix}/default`, "TEXT", column.defaultValue),
    );
  }
  return fields;
}

function orderedRows(
  driver: DbDriver,
  database: "main" | "sys",
  table: string,
  tableColumns: Column[],
): SqlRow[] {
  const primary = tableColumns.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk);
  if (primary.length === 0) throw invalid(`table ${database}.${table} has no stable primary key`);
  const order = primary.map(column => qid(column.name)).join(",");
  const textColumns = tableColumns.filter(column => column.type === "TEXT");
  const rawText = textColumns.map(column =>
    `hex(CAST(${qid(column.name)} AS BLOB)) AS "__clay_text_bytes_${column.cid}"`);
  const rows = driver.select(
    `SELECT *${rawText.length ? `, ${rawText.join(", ")}` : ""}
     FROM ${database}.${qid(table)} ORDER BY ${order}`,
  );
  for (const row of rows) {
    for (const column of textColumns) {
      const value = row[column.name];
      if (value === null) continue;
      const hex = row[`__clay_text_bytes_${column.cid}`];
      if (typeof value !== "string" || typeof hex !== "string" || !RAW_TEXT_HEX.test(hex))
        throw invalid("SQLite text bytes are invalid");
      const bytes = new Uint8Array(hex.length / 2);
      for (let index = 0; index < bytes.length; index++)
        bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
      try {
        if (rawTextDecoder.decode(bytes) !== value) throw invalid("SQLite text bytes are invalid");
      } catch {
        throw invalid("SQLite text bytes are invalid");
      }
    }
  }
  return rows;
}

function canonicalFields(tableColumns: Column[], row: SqlRow): StateLeafFieldV1[] {
  return tableColumns.map(column => {
    if (!(column.name in row)) throw invalid();
    return canonicalSqlFieldV1(column.name, column.type, row[column.name] ?? null);
  });
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function enumerateMainIndexes(driver: DbDriver, registry: Registry): CanonicalStateLeafEntryV1[] {
  const rows = driver.select(
    `SELECT name, tbl_name, sql FROM main.sqlite_master
     WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  );
  const authorized = userIndexAuthorities(driver, registry);
  const fixedSeen = new Set<string>();
  const userSeen = new Set<string>();
  const leaves = rows.map(row => {
    if (typeof row.name !== "string" || typeof row.tbl_name !== "string"
        || typeof row.sql !== "string")
      throw invalid("main index inventory is ambiguous");
    const fixedSql = (MAIN_INDEX_SQL as Record<string, string>)[row.name];
    if (fixedSql !== undefined) {
      if (row.tbl_name !== "row_history" || normalizeSql(row.sql) !== normalizeSql(fixedSql))
        throw invalid("main index inventory is ambiguous");
      fixedSeen.add(row.name);
      return {
        source: { database: "main" as const, table: "sqlite_schema" },
        seed: {
          key: `schema/index/main/${row.name}`,
          fields: [
            canonicalSqlFieldV1("name", "TEXT", row.name),
            canonicalSqlFieldV1("table", "TEXT", "row_history"),
            canonicalSqlFieldV1("unique", "INTEGER", row.name.endsWith("_sequence") ? 1 : 0),
            canonicalSqlFieldV1("sql", "TEXT", normalizeSql(fixedSql)),
          ],
        },
      };
    }
    const authorization = authorized.get(row.name);
    if (!authorization)
      throw invalid("main index inventory is ambiguous");
    const table = registry.get(row.tbl_name);
    if (!table || !table.semantic || !isTableId(table.semantic.tableId))
      throw invalid("main index table identity is invalid");
    const indexInfo = driver.select(`PRAGMA main.index_info(${qindex(row.name)})`);
    const columnName = indexInfo[0]?.name;
    const column = typeof columnName === "string"
      ? table.columns.find(candidate => candidate.name === columnName && !isVirtualColumn(candidate))
      : undefined;
    const metadata = driver.select(`PRAGMA main.index_list(${qid(table.name)})`)
      .find(candidate => candidate.name === row.name);
    const expectedSql = column === undefined ? ""
      : `CREATE INDEX "${row.name}" ON "${table.name}"("${column.name}")`;
    if (indexInfo.length !== 1 || !column?.semantic || !isFieldId(column.semantic.fieldId)
        || table.semantic.tableId !== authorization.tableId
        || column.semantic.fieldId !== authorization.fieldId
        || Number(metadata?.unique ?? -1) !== 0 || Number(metadata?.partial ?? -1) !== 0
        || metadata?.origin !== "c" || row.sql !== expectedSql)
      throw invalid("main index metadata is noncanonical");
    if (!authorization.active) return null;
    userSeen.add(row.name);
    return {
      source: { database: "main" as const, table: "sqlite_schema" },
      seed: {
        key: `schema/index/main/${table.semantic.tableId}/${column.semantic.fieldId}`
          + `/v:${authorization.version}/o:${authorization.operationIndex}`,
        fields: [
          canonicalSqlFieldV1("name", "TEXT", row.name),
          canonicalSqlFieldV1("table", "TEXT", table.name),
          canonicalSqlFieldV1("column", "TEXT", column.name),
          canonicalSqlFieldV1("table_id", "TEXT", table.semantic.tableId),
          canonicalSqlFieldV1("field_id", "TEXT", column.semantic.fieldId),
          canonicalSqlFieldV1("version", "INTEGER", authorization.version),
          canonicalSqlFieldV1("operation_index", "INTEGER", authorization.operationIndex),
          canonicalSqlFieldV1("unique", "INTEGER", 0),
          canonicalSqlFieldV1("sql", "TEXT", expectedSql),
        ],
      },
    };
  });
  if (fixedSeen.size !== Object.keys(MAIN_INDEX_SQL).length)
    throw invalid("main index inventory is incomplete");
  const expectedActive = [...authorized.values()].filter(index => index.active).length;
  if (userSeen.size !== expectedActive)
    throw invalid("active user index inventory is incomplete");
  return leaves.filter((leaf): leaf is NonNullable<(typeof leaves)[number]> => leaf !== null);
}

function enumerateSystemIndexes(driver: DbDriver): CanonicalStateLeafEntryV1[] {
  const rows = driver.select(
    `SELECT name, tbl_name, sql FROM sys.sqlite_master
     WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  );
  const expected = Object.entries(SYSTEM_INDEX_SQL);
  if (rows.length !== expected.length && rows.length !== expected.length + 1)
    throw invalid("system index inventory is ambiguous");
  const trusted = rows.slice(0, expected.length);
  for (let index = 0; index < expected.length; index++) {
    const row = trusted[index]!;
    const [name, sql] = expected[index]!;
    if (row.name !== name || typeof row.sql !== "string"
        || normalizeSql(row.sql) !== normalizeSql(sql))
      throw invalid("system index inventory is ambiguous");
  }
  if (rows.length > expected.length) {
    const self = rows[expected.length]!;
    if (self.name !== "idx_state_digest_leaves_bucket" || typeof self.sql !== "string"
        || normalizeSql(self.sql) !== normalizeSql(MERKLE_INDEX_SQL))
      throw invalid("system index inventory is ambiguous");
  }
  return trusted.map((row, index) => {
    const [name, sql] = expected[index]!;
    if (typeof row.tbl_name !== "string") throw invalid();
    return {
      source: { database: "sys" as const, table: "sqlite_schema" },
      seed: {
        key: `schema/index/sys/${name}`,
        fields: [
          canonicalSqlFieldV1("name", "TEXT", name),
          canonicalSqlFieldV1("table", "TEXT", row.tbl_name),
          canonicalSqlFieldV1("unique", "INTEGER", 0),
          canonicalSqlFieldV1("sql", "TEXT", normalizeSql(sql)),
        ],
      },
    };
  });
}

function tableSchemaLeaf(
  driver: DbDriver,
  database: "main" | "sys",
  table: string,
  keyName: string,
): CanonicalStateLeafEntryV1 {
  const rows = driver.select(
    `SELECT type, name, sql FROM ${database}.sqlite_master WHERE type = 'table' AND name = ?`,
    [table],
  );
  if (rows.length !== 1 || rows[0]!.type !== "table" || rows[0]!.name !== table
      || typeof rows[0]!.sql !== "string")
    throw invalid("table schema inventory is ambiguous");
  return {
    source: { database, table: "sqlite_schema" },
    seed: {
      key: `schema/table/${database}/${keyName}`,
      fields: [
        canonicalSqlFieldV1("database", "TEXT", database),
        canonicalSqlFieldV1("name", "TEXT", table),
        ...canonicalTableSchemaFieldsV1(driver, database, table),
      ],
    },
  };
}

function enumerateTableSchemas(driver: DbDriver, registry: Registry): CanonicalStateLeafEntryV1[] {
  const leaves = [
    tableSchemaLeaf(driver, "main", "row_history", "row_history"),
    tableSchemaLeaf(driver, "main", "__clay_attachments", "__clay_attachments"),
  ];
  const dynamic = [...registry.values()].sort((left, right) => {
    const leftId = left.semantic?.tableId;
    const rightId = right.semantic?.tableId;
    if (!leftId || !rightId) throw invalid();
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  for (const table of dynamic) {
    if (!table.semantic || !isTableId(table.semantic.tableId)) throw invalid();
    leaves.push(tableSchemaLeaf(driver, "main", table.name, table.semantic.tableId));
  }
  for (const table of [...SYSTEM_TABLES, "sqlite_sequence"].sort())
    leaves.push(tableSchemaLeaf(driver, "sys", table, table));
  return leaves;
}

function validateSystemObjectInventory(driver: DbDriver): void {
  const rows = driver.select(
    `SELECT type, name FROM sys.sqlite_master
     WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','view','trigger') ORDER BY name`,
  );
  if (rows.some(row => row.type !== "table" || typeof row.name !== "string"))
    throw invalid("system object inventory is ambiguous");
  const actual = new Set(rows.map(row => String(row.name)));
  const required = new Set<string>([...SYSTEM_TABLES, ...EXCLUDED_SYSTEM_TABLES]);
  const merkleCount = MERKLE_SYSTEM_TABLES.filter(table => actual.has(table)).length;
  if (merkleCount !== 0 && merkleCount !== MERKLE_SYSTEM_TABLES.length)
    throw invalid("system object inventory is ambiguous");
  if (merkleCount === MERKLE_SYSTEM_TABLES.length)
    for (const table of MERKLE_SYSTEM_TABLES) required.add(table);
  const authorityCount = TARGET_AUTHORITY_SYSTEM_TABLES.filter(table => actual.has(table)).length;
  if (authorityCount !== 0 && authorityCount !== TARGET_AUTHORITY_SYSTEM_TABLES.length)
    throw invalid("system object inventory is ambiguous");
  if (authorityCount === TARGET_AUTHORITY_SYSTEM_TABLES.length)
    for (const table of TARGET_AUTHORITY_SYSTEM_TABLES) required.add(table);
  if (actual.size !== required.size || [...actual].some(table => !required.has(table)))
    throw invalid("system object inventory is ambiguous");
}

function textKey(row: SqlRow, name: string): string {
  const value = (row as Record<string, unknown>)[name];
  if (typeof value !== "string") throw invalid("text identity is invalid");
  return canonicalTextKeyV1(value);
}

function integerKey(row: SqlRow, name: string): string {
  const value = (row as Record<string, unknown>)[name];
  if (typeof value === "bigint") return canonicalIntegerKeyV1(value.toString());
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw invalid("integer identity is invalid");
  return canonicalIntegerKeyV1(Object.is(value, -0) ? "0" : value.toString());
}

function systemRowKey(table: string, row: SqlRow, registry: Registry): string {
  switch (table) {
    case "tables_registry": {
      const name = (row as Record<string, unknown>).table_name;
      const specJson = (row as Record<string, unknown>).spec_json;
      if (typeof name !== "string" || typeof specJson !== "string") throw invalid();
      const registered = registry.get(name);
      if (!registered?.semantic || !isTableId(registered.semantic.tableId)) throw invalid();
      const stored = JSON.parse(specJson) as { semantic?: { tableId?: unknown } };
      if (stored.semantic?.tableId !== registered.semantic.tableId) throw invalid();
      return `schema/table/${registered.semantic.tableId}`;
    }
    case "version_log": case "checkpoints":
      return `system/${table}/${integerKey(row, "version")}`;
    case "panel_blobs": case "panel_tombstones":
      return `system/${table}/${integerKey(row, "version")}/${textKey(row, "panel_id")}`;
    case "usage_events": case "suggestions": case "attempts": case "operation_batches":
    case "automations": case "automation_runs": case "notifications":
      return `system/${table}/${textKey(row, "id")}`;
    case "settings":
      return `system/settings/${textKey(row, "key")}`;
    case "automation_matches":
      return `system/automation_matches/${textKey(row, "automation_id")}/${textKey(row, "row_id")}`;
    case "record_events":
      return `system/record_events/${textKey(row, "id")}`;
    case "inactive_cells": {
      const tableName = (row as Record<string, unknown>).table_name;
      const columnName = (row as Record<string, unknown>).column_name;
      if (typeof tableName !== "string" || typeof columnName !== "string") throw invalid();
      const registered = registry.get(tableName);
      const column = registered?.columns.find(candidate => candidate.name === columnName);
      if (!registered?.semantic || !isTableId(registered.semantic.tableId)
          || !column?.semantic || !isFieldId(column.semantic.fieldId)) throw invalid();
      return `system/inactive_cells/${registered.semantic.tableId}/${column.semantic.fieldId}/${textKey(row, "row_id")}`;
    }
    default:
      throw invalid(`system table ${table} has no identity policy`);
  }
}

function enumerateSystemTable(
  driver: DbDriver,
  table: string,
  registry: Registry,
): { coverage: CanonicalStateEnumerationV1["coverage"][number]; leaves: CanonicalStateLeafEntryV1[] } {
  const tableColumns = columns(driver, "sys", table);
  const rows = orderedRows(driver, "sys", table, tableColumns);
  if (table === "settings" && rows.some(row => isLegacyCredentialSettingKey(row.key)))
    throw invalid("legacy credential setting blocks target enumeration");
  return {
    coverage: { database: "sys", table, rowCount: rows.length },
    leaves: rows.map(row => ({
      source: { database: "sys", table },
      seed: {
        key: systemRowKey(table, row, registry),
        fields: canonicalFields(tableColumns, row),
      },
    })),
  };
}

function enumerateSqliteSequence(
  driver: DbDriver,
): { coverage: CanonicalStateEnumerationV1["coverage"][number]; leaves: CanonicalStateLeafEntryV1[] } {
  const rows = driver.select("SELECT name, seq FROM sys.sqlite_sequence ORDER BY name");
  if (rows.some(row => row.name !== "record_events")) throw invalid("unknown AUTOINCREMENT authority");
  return {
    coverage: { database: "sys", table: "sqlite_sequence", rowCount: rows.length },
    leaves: rows.map(row => ({
      source: { database: "sys" as const, table: "sqlite_sequence" },
      seed: {
        key: `system/sqlite_sequence/${textKey(row, "name")}`,
        fields: [
          canonicalSqlFieldV1("name", "TEXT", row.name ?? null),
          canonicalSqlFieldV1("seq", "INTEGER", row.seq ?? null),
        ],
      },
    })),
  };
}

function enumerateInternalMainTable(
  driver: DbDriver,
  table: "row_history" | "__clay_attachments",
): { coverage: CanonicalStateEnumerationV1["coverage"][number]; leaves: CanonicalStateLeafEntryV1[] } {
  const tableColumns = columns(driver, "main", table);
  const rows = orderedRows(driver, "main", table, tableColumns);
  const leaves = rows.map(row => {
    if (typeof row.id !== "string") throw invalid("internal row identity is invalid");
    const key = table === "row_history"
      ? `system/row_history/${canonicalTextKeyV1(row.id)}`
      : `attachment/${canonicalTextKeyV1(row.id)}`;
    if (table === "row_history") return {
      source: { database: "main" as const, table },
      seed: { key, fields: canonicalFields(tableColumns, row) },
    };
    if (!(row.bytes instanceof Uint8Array) || typeof row.sha256 !== "string"
        || !CONTENT_SHA.test(row.sha256) || typeof row.size !== "number"
        || !Number.isSafeInteger(row.size) || row.size < 0
        || row.bytes.byteLength !== row.size || sha256HexSync(row.bytes) !== row.sha256)
      throw invalid("attachment content evidence failed validation");
    const fields = tableColumns
      .filter(column => column.name !== "bytes" && column.name !== "sha256" && column.name !== "size")
      .map(column => canonicalSqlFieldV1(
        column.name, column.type, row[column.name] as string | number | null,
      ));
    fields.push(canonicalContentFieldV1("content", `sha256:${row.sha256}`, String(row.size)));
    return { source: { database: "main" as const, table }, seed: { key, fields } };
  });
  return { coverage: { database: "main", table, rowCount: rows.length }, leaves };
}

function enumerateUserTable(
  driver: DbDriver,
  name: string,
  registry: Registry,
): { coverage: CanonicalStateEnumerationV1["coverage"][number]; leaves: CanonicalStateLeafEntryV1[] } {
  const table = registry.get(name);
  if (!table || table.name !== name || !table.semantic || !isTableId(table.semantic.tableId)) throw invalid();
  const physicalColumns = table.columns.filter(column => !isVirtualColumn(column));
  for (const column of physicalColumns)
    if (!column.semantic || !isFieldId(column.semantic.fieldId)) throw invalid();
  const expected = [
    ...KERNEL_COLUMNS,
    ...physicalColumns.map(column => ({ name: column.name, type: STORAGE_TYPE[column.type]! })),
  ];
  const actual = columns(driver, "main", name);
  if (actual.length !== expected.length || actual.some((column, index) =>
    column.name !== expected[index]!.name || column.type !== expected[index]!.type)) throw invalid();
  const rows = orderedRows(driver, "main", name, actual);
  const leaves = rows.map(row => {
    if (typeof row.id !== "string" || !ROW_ID.test(row.id)) throw invalid("record identity is invalid");
    const fields: StateLeafFieldV1[] = KERNEL_COLUMNS.map(column =>
      canonicalSqlFieldV1(column.name, column.type, row[column.name] as string | null));
    for (const column of physicalColumns) {
      const value = row[column.name] as string | number | null;
      if (column.type === "boolean" && value !== null && value !== 0 && value !== 1)
        throw invalid("boolean storage is outside its logical domain");
      fields.push(canonicalSqlFieldV1(
        `field/${column.semantic!.fieldId}`,
        STORAGE_TYPE[column.type]!,
        value,
      ));
    }
    return {
      source: { database: "main" as const, table: name },
      seed: { key: `row/${table.semantic!.tableId}/${canonicalTextKeyV1(row.id)}`, fields },
    };
  });
  return { coverage: { database: "main", table: name, rowCount: rows.length }, leaves };
}

export function enumerateCanonicalStateV1(
  driver: DbDriver,
  registry: Registry,
): CanonicalStateEnumerationV1 {
  try {
    validateSystemObjectInventory(driver);
    const expectedMain = new Set(["row_history", "__clay_attachments", ...registry.keys()]);
    const mainObjects = driver.select(
      `SELECT type, name FROM main.sqlite_master
       WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','view','trigger') ORDER BY name`,
    );
    if (mainObjects.length !== expectedMain.size || mainObjects.some(row =>
      row.type !== "table" || typeof row.name !== "string" || !expectedMain.has(row.name)))
      throw invalid("main database inventory is ambiguous");

    const coverage: CanonicalStateEnumerationV1["coverage"] = [];
    const leaves: CanonicalStateLeafEntryV1[] = [];
    for (const table of [...expectedMain].sort()) {
      const result = table === "row_history" || table === "__clay_attachments"
        ? enumerateInternalMainTable(driver, table)
        : enumerateUserTable(driver, table, registry);
      coverage.push(result.coverage);
      leaves.push(...result.leaves);
    }
    leaves.push(...enumerateMainIndexes(driver, registry));
    leaves.push(...enumerateSystemIndexes(driver));
    leaves.push(...enumerateTableSchemas(driver, registry));
    for (const table of [...SYSTEM_TABLES].sort()) {
      const result = enumerateSystemTable(driver, table, registry);
      coverage.push(result.coverage);
      leaves.push(...result.leaves);
    }
    const sequence = enumerateSqliteSequence(driver);
    coverage.push(sequence.coverage);
    leaves.push(...sequence.leaves);
    leaves.sort((left, right) => left.seed.key < right.seed.key ? -1 : left.seed.key > right.seed.key ? 1 : 0);
    if (new Set(leaves.map(entry => entry.seed.key)).size !== leaves.length) throw invalid();
    return {
      schema: 1,
      coverage,
      leaves,
      stateSha256: stateRootV1(leaves.map(entry => ({
        key: entry.seed.key,
        sha256: stateLeafHashV1(entry.seed.key, entry.seed.fields),
      }))),
    };
  } catch (error) {
    if (error instanceof ClayError && error.code === "E_STATE_DIGEST_INVALID") throw error;
    throw invalid();
  }
}

export function verifyCanonicalStateV1(
  driver: DbDriver,
  registry: Registry,
): CanonicalStateEnumerationV1 {
  try {
    return driver.tx(() => {
      const enumeration = enumerateCanonicalStateV1(driver, registry);
      const persisted = StateMerkleIndex.open(driver).audit();
      if (persisted.stateSha256 !== enumeration.stateSha256
          || persisted.leafCount !== enumeration.leaves.length)
        throw invalid("persisted state digest disagrees with canonical target state");
      return enumeration;
    });
  } catch (error) {
    if (error instanceof ClayError && error.code === "E_STATE_DIGEST_INVALID") throw error;
    throw invalid();
  }
}
