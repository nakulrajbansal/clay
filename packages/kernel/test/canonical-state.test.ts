import { describe, expect, it } from "vitest";
import {
  ClayError,
  ClayStore,
  deriveInverse,
  type DbDriver,
  type ForwardOpT,
} from "../src/index";
import { SYSTEM_TABLES } from "../src/db";
import {
  enumerateCanonicalStateV1,
  verifyCanonicalStateV1,
} from "../src/canonical-state";
import { StateMerkleIndex } from "../src/state-merkle-index";

async function fixture(): Promise<{
  store: ClayStore;
  driver: DbDriver;
  rowId: string;
  attachmentId: string;
}> {
  const store = await ClayStore.openMemory();
  const operations: ForwardOpT[] = [{ op: "create_table", table: "projects", columns: [
    { name: "name", type: "text", required: true },
    { name: "estimate", type: "number", required: false },
    { name: "count", type: "integer", required: false },
    { name: "done", type: "boolean", required: false },
    { name: "files", type: "attachment", required: false },
  ] }];
  store.commit({
    intent: "canonical fixture",
    summary: "Creates a typed table for target digest enumeration.",
    migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
  });
  const row = store.insert("projects", {
    name: "Apollo", estimate: 42.5, count: 2, done: false,
  });
  const attachment = await store.addAttachment({
    table: "projects",
    rowId: String(row.id),
    field: "files",
    name: "contract.pdf",
    mime: "application/pdf",
    bytes: new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]),
  });
  return {
    store,
    driver: (store as unknown as { driver: DbDriver }).driver,
    rowId: String(row.id),
    attachmentId: attachment.id,
  };
}

function seedSystemIdentityFamilies(driver: DbDriver, rowId: string): void {
  driver.exec(`INSERT INTO sys.attempts VALUES (
    'attempt_probe','2026-09-05T00:00:00.000Z','probe','applied',NULL)`);
  driver.exec(`INSERT INTO sys.automations VALUES (
    'automation_probe','{}','2026-09-05T00:00:00.000Z','2026-09-05T00:00:00.000Z',0)`);
  driver.exec(`INSERT INTO sys.automation_runs VALUES (
    'run_probe','automation_probe','2026-09-05T00:00:00.000Z','trigger_probe','succeeded',1,1,NULL,NULL,NULL)`);
  driver.exec(`INSERT INTO sys.automation_matches VALUES (
    'automation_probe',?)`, [rowId]);
  driver.exec("INSERT INTO sys.checkpoints VALUES (999,'Probe','2026-09-05T00:00:00.000Z')");
  driver.exec("INSERT INTO sys.inactive_cells VALUES ('projects','name',?)", [rowId]);
  driver.exec(`INSERT INTO sys.notifications VALUES (
    'notification_probe','2026-09-05T00:00:00.000Z','automation_probe','run_probe',
    'Probe','Body','projects',?,NULL,NULL)`, [rowId]);
  driver.exec(`INSERT INTO sys.operation_batches VALUES (
    'batch_probe','2026-09-05T00:00:00.000Z','user','Probe',1,'[]',NULL)`);
  driver.exec(`INSERT INTO sys.panel_blobs VALUES (
    999,'panel_probe','export default {}','{}','[]')`);
  driver.exec("INSERT INTO sys.panel_tombstones VALUES (999,'panel_probe')");
  driver.exec(`INSERT INTO sys.suggestions VALUES (
    'suggestion_probe','probe','subject','open','2026-09-05T00:00:00.000Z')`);
}

function expectStateError(run: () => unknown): void {
  let thrown: unknown;
  try { run(); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(ClayError);
  expect((thrown as ClayError).code).toBe("E_STATE_DIGEST_INVALID");
}

describe("canonical target-state enumeration", () => {
  it("covers every archive-visible row with semantic user keys and content references", async () => {
    const { store, driver, rowId, attachmentId } = await fixture();
    try {
      const registry = store.validationRegistrySnapshot();
      const result = enumerateCanonicalStateV1(driver, registry);
      const mainTables = result.coverage
        .filter(entry => entry.database === "main").map(entry => entry.table).sort();
      const systemTables = result.coverage
        .filter(entry => entry.database === "sys").map(entry => entry.table).sort();
      expect(mainTables).toEqual(["__clay_attachments", "projects", "row_history"]);
      expect(systemTables).toEqual([...SYSTEM_TABLES, "sqlite_sequence"].sort());
      let physicalRowCount = 0;
      for (const entry of result.coverage) {
        expect(entry.table).toMatch(/^[a-z_]+$/);
        const count = driver.select(
          `SELECT COUNT(*) AS count FROM ${entry.database}."${entry.table}"`,
        );
        expect(count).toHaveLength(1);
        expect(entry.rowCount).toBe(count[0]!.count);
        physicalRowCount += Number(count[0]!.count);
      }
      expect(result.leaves).toHaveLength(physicalRowCount + 24);
      expect(result.leaves.filter(entry => entry.seed.key.startsWith("schema/index/main/"))
        .map(entry => entry.seed.key)).toEqual([
          "schema/index/main/idx_row_history_batch",
          "schema/index/main/idx_row_history_sequence",
        ]);
      expect(result.leaves.filter(entry => entry.seed.key.startsWith("schema/index/sys/"))
        .map(entry => entry.seed.key)).toEqual([
          "schema/index/sys/idx_automation_runs_rule",
          "schema/index/sys/idx_record_events_table_seq",
        ]);
      expect(result.leaves.map(entry => entry.seed.key)).toEqual(expect.arrayContaining([
        "schema/table/main/row_history",
        "schema/table/sys/settings",
        "schema/table/sys/sqlite_sequence",
      ]));

      const table = registry.get("projects")!;
      expect(result.leaves.map(entry => entry.seed.key)).toContain(
        `schema/table/main/${table.semantic!.tableId}`,
      );
      const project = result.leaves.find(entry =>
        entry.source.database === "main" && entry.source.table === "projects"
        && entry.seed.fields.some(field => field.name === "id" && field.kind === "text"
          && field.value === rowId));
      expect(project?.seed.key).toBe(
        `row/${table.semantic!.tableId}/t:${Buffer.from(rowId, "utf8").toString("base64url")}`,
      );
      for (const column of table.columns.filter(column =>
        !["computed", "lookup", "rollup"].includes(column.type))) {
        expect(project?.seed.fields.map(field => field.name)).toContain(
          `field/${column.semantic!.fieldId}`,
        );
      }

      const attachment = result.leaves.find(entry =>
        entry.source.database === "main" && entry.source.table === "__clay_attachments"
        && entry.seed.fields.some(field => field.name === "id" && field.kind === "text"
          && field.value === attachmentId));
      expect(attachment?.seed.fields.some(field => field.kind === "content")).toBe(true);
      expect(attachment?.seed.fields.some(field => "value" in field
        && (field as { value?: unknown }).value instanceof Uint8Array)).toBe(false);
      const registryLeaf = result.leaves.find(entry =>
        entry.source.database === "sys" && entry.source.table === "tables_registry");
      expect(registryLeaf?.seed.key).toBe(`schema/table/${table.semantic!.tableId}`);

      expect(result.leaves.some(entry => entry.source.table === "sqlite_sequence"
        && entry.seed.key === "system/sqlite_sequence/t:cmVjb3JkX2V2ZW50cw")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("enumerates every system identity policy with a real row", async () => {
    const { store, driver, rowId } = await fixture();
    try {
      seedSystemIdentityFamilies(driver, rowId);
      const registry = store.validationRegistrySnapshot();
      const table = registry.get("projects")!;
      const field = table.columns.find(column => column.name === "name")!;
      const t = (value: string) => `t:${Buffer.from(value, "utf8").toString("base64url")}`;
      const keys = new Set(enumerateCanonicalStateV1(driver, registry).leaves
        .map(entry => entry.seed.key));
      for (const key of [
        `system/attempts/${t("attempt_probe")}`,
        `system/automations/${t("automation_probe")}`,
        `system/automation_runs/${t("run_probe")}`,
        `system/automation_matches/${t("automation_probe")}/${t(rowId)}`,
        "system/checkpoints/i:999",
        `system/inactive_cells/${table.semantic!.tableId}/${field.semantic!.fieldId}/${t(rowId)}`,
        `system/notifications/${t("notification_probe")}`,
        `system/operation_batches/${t("batch_probe")}`,
        `system/panel_blobs/i:999/${t("panel_probe")}`,
        `system/panel_tombstones/i:999/${t("panel_probe")}`,
        `system/suggestions/${t("suggestion_probe")}`,
      ]) expect(keys.has(key), key).toBe(true);
    } finally {
      store.close();
    }
  });

  it("rejects invalid raw SQLite UTF-8 before decoded values can collide", async () => {
    for (const bytes of ["80", "81"]) {
      const { store, driver, rowId } = await fixture();
      try {
        driver.exec(`UPDATE projects SET name = CAST(X'${bytes}' AS TEXT) WHERE id = ?`, [rowId]);
        expectStateError(() => enumerateCanonicalStateV1(
          driver, store.validationRegistrySnapshot(),
        ));
      } finally {
        store.close();
      }
    }
  });

  it("fails closed when attachment bytes disagree with stored content evidence", async () => {
    const { store, driver, attachmentId } = await fixture();
    try {
      driver.exec("UPDATE __clay_attachments SET bytes=? WHERE id=?", [
        new Uint8Array([37, 80, 68, 70, 45, 57, 46, 57]), attachmentId,
      ]);
      expectStateError(() => enumerateCanonicalStateV1(
        driver, store.validationRegistrySnapshot(),
      ));
    } finally {
      store.close();
    }
  });

  it("rejects legacy credential settings instead of hashing or exporting them", async () => {
    const { store, driver } = await fixture();
    try {
      for (const key of [
        "byo_api_key", "anthropic_api_key", "openai_api_key", "api_key", "clay_session",
        "backend_url", "clay_backend_url",
      ]) {
        driver.exec("INSERT OR REPLACE INTO sys.settings(key,value_json) VALUES (?,?)",
          [key, '"placeholder"']);
        expectStateError(() => enumerateCanonicalStateV1(
          driver, store.validationRegistrySnapshot(),
        ));
        driver.exec("DELETE FROM sys.settings WHERE key = ?", [key]);
      }
    } finally {
      store.close();
    }
  });

  it("rejects physical values outside a field's logical boolean domain", async () => {
    const { store, driver, rowId } = await fixture();
    try {
      driver.exec("UPDATE projects SET done = 2 WHERE id = ?", [rowId]);
      expectStateError(() => enumerateCanonicalStateV1(
        driver, store.validationRegistrySnapshot(),
      ));
    } finally {
      store.close();
    }
  });

  it("excludes local private metrics from target-state identity", async () => {
    const { store, driver } = await fixture();
    try {
      const registry = store.validationRegistrySnapshot();
      const before = enumerateCanonicalStateV1(driver, registry);
      driver.exec(
        `UPDATE sys.private_metric_state
         SET collection_enabled = 1, ever_activated = 1, ever_proof_loop = 1
         WHERE id = 1`,
      );
      driver.exec(
        `INSERT INTO sys.private_metric_daily(day_utc,metric_code,variant_code,n)
         VALUES (999999,999,999,1)`,
      );
      const after = enumerateCanonicalStateV1(driver, registry);
      expect(after.stateSha256).toBe(before.stateSha256);
      expect(after.coverage.some(entry => entry.table.startsWith("private_metric_"))).toBe(false);
    } finally {
      store.close();
    }
  });

  it("enumerates a supported user index by semantic table and field identity", async () => {
    const { store, driver } = await fixture();
    try {
      const operations: ForwardOpT[] = [{ op: "add_index", table: "projects", column: "name" }];
      store.commit({
        intent: "index fixture",
        summary: "Adds a supported user index.",
        migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
      });
      store.commit({
        intent: "non-schema fixture", summary: "Keeps the active index across a non-schema commit.",
        migration: null,
      });
      const registry = store.validationRegistrySnapshot();
      const table = registry.get("projects")!;
      const field = table.columns.find(column => column.name === "name")!;
      const result = enumerateCanonicalStateV1(driver, registry);
      expect(result.leaves.some(entry => entry.seed.key.startsWith(
        `schema/index/main/${table.semantic!.tableId}/${field.semantic!.fieldId}/`
      ))).toBe(true);
    } finally {
      store.close();
    }
  });

  it("keeps a supported index bound to semantic identity across field rename", async () => {
    const { store, driver } = await fixture();
    try {
      const addIndex: ForwardOpT[] = [{ op: "add_index", table: "projects", column: "name" }];
      store.commit({
        intent: "index fixture", summary: "Adds a supported user index.",
        migration: { operations: addIndex, inverse: deriveInverse(addIndex, store.registrySnapshot()) },
      });
      const before = store.validationRegistrySnapshot().get("projects")!;
      const tableId = before.semantic!.tableId;
      const fieldId = before.columns.find(column => column.name === "name")!.semantic!.fieldId;
      const rename: ForwardOpT[] = [{
        op: "rename_column", table: "projects", from: "name", to: "title",
      }];
      store.commit({
        intent: "rename fixture", summary: "Renames the indexed field.",
        migration: { operations: rename, inverse: deriveInverse(rename, store.registrySnapshot()) },
      });
      const result = enumerateCanonicalStateV1(driver, store.validationRegistrySnapshot());
      expect(result.leaves.some(entry => entry.seed.key.startsWith(
        `schema/index/main/${tableId}/${fieldId}/`
      ))).toBe(true);
    } finally {
      store.close();
    }
  });

  it("derives user index authority from the active version cursor", async () => {
    const { store, driver } = await fixture();
    try {
      const addIndex: ForwardOpT[] = [{ op: "add_index", table: "projects", column: "name" }];
      store.commit({
        intent: "index fixture", summary: "Adds a supported user index.",
        migration: { operations: addIndex, inverse: deriveInverse(addIndex, store.registrySnapshot()) },
      });
      const indexedRegistry = store.validationRegistrySnapshot();
      const table = indexedRegistry.get("projects")!;
      const field = table.columns.find(column => column.name === "name")!;
      const key = `schema/index/main/${table.semantic!.tableId}/${field.semantic!.fieldId}/`;
      expect(enumerateCanonicalStateV1(driver, indexedRegistry).leaves
        .some(entry => entry.seed.key.startsWith(key))).toBe(true);

      store.rollbackTo(1);
      expect(enumerateCanonicalStateV1(driver, store.validationRegistrySnapshot()).leaves
        .some(entry => entry.seed.key.startsWith(key))).toBe(false);
      store.rollForwardTo(2);
      expect(enumerateCanonicalStateV1(driver, store.validationRegistrySnapshot()).leaves
        .some(entry => entry.seed.key.startsWith(key))).toBe(true);

      store.rollbackTo(1, { truncate: true });
      const replacement: ForwardOpT[] = [{
        op: "add_column", table: "projects",
        column: { name: "note", type: "text", required: false },
      }];
      store.commit({
        intent: "truncate fixture", summary: "Truncates the future index version.",
        migration: { operations: replacement,
          inverse: deriveInverse(replacement, store.registrySnapshot()) },
      });
      expect(enumerateCanonicalStateV1(driver, store.validationRegistrySnapshot()).leaves
        .some(entry => entry.seed.key.startsWith(key))).toBe(false);
    } finally {
      store.close();
    }
  });

  it("excludes a retained future index on a plan-created column while rewound", async () => {
    const { store, driver } = await fixture();
    try {
      const operations: ForwardOpT[] = [
        { op: "add_column", table: "projects", column: {
          name: "priority", type: "text", required: false,
        } },
        { op: "add_index", table: "projects", column: "priority" },
      ];
      store.commit({
        intent: "future index", summary: "Adds an indexed future field.",
        migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
      });
      const indexed = store.validationRegistrySnapshot().get("projects")!;
      const fieldId = indexed.columns.find(column => column.name === "priority")!.semantic!.fieldId;
      const prefix = `schema/index/main/${indexed.semantic!.tableId}/${fieldId}/`;
      store.rollbackTo(1);
      const result = enumerateCanonicalStateV1(driver, store.validationRegistrySnapshot());
      expect(result.leaves.some(entry => entry.seed.key.startsWith(prefix))).toBe(false);
    } finally {
      store.close();
    }
  });

  it("preserves semantic user index leaves through archive reconstruction", async () => {
    const { store } = await fixture();
    let imported: ClayStore | undefined;
    try {
      const addIndex: ForwardOpT[] = [{ op: "add_index", table: "projects", column: "name" }];
      store.commit({
        intent: "index fixture", summary: "Adds a supported user index.",
        migration: { operations: addIndex, inverse: deriveInverse(addIndex, store.registrySnapshot()) },
      });
      const rename: ForwardOpT[] = [{
        op: "rename_column", table: "projects", from: "name", to: "title",
      }];
      store.commit({
        intent: "rename fixture", summary: "Renames the indexed field before export.",
        migration: { operations: rename, inverse: deriveInverse(rename, store.registrySnapshot()) },
      });
      imported = (await ClayStore.importArchive(await store.exportArchive("canonical-index"))).store;
      const registry = imported.validationRegistrySnapshot();
      const table = registry.get("projects")!;
      const field = table.columns.find(column => column.name === "title")!;
      const key = `schema/index/main/${table.semantic!.tableId}/${field.semantic!.fieldId}/`;
      const driver = (imported as unknown as { driver: DbDriver }).driver;
      expect(enumerateCanonicalStateV1(driver, registry).leaves
        .some(entry => entry.seed.key.startsWith(key))).toBe(true);
    } finally {
      imported?.close();
      store.close();
    }
  });

  it("keeps distinct authorized leaves when a renamed field is indexed again", async () => {
    const { store, driver } = await fixture();
    try {
      const add: ForwardOpT[] = [{ op: "add_index", table: "projects", column: "name" }];
      store.commit({
        intent: "index", summary: "Adds the original field index.",
        migration: { operations: add, inverse: deriveInverse(add, store.registrySnapshot()) },
      });
      const rename: ForwardOpT[] = [{
        op: "rename_column", table: "projects", from: "name", to: "title",
      }];
      store.commit({
        intent: "rename", summary: "Renames the indexed field.",
        migration: { operations: rename, inverse: deriveInverse(rename, store.registrySnapshot()) },
      });
      const reindex: ForwardOpT[] = [{ op: "add_index", table: "projects", column: "title" }];
      store.commit({
        intent: "reindex", summary: "Indexes the renamed field.",
        migration: { operations: reindex, inverse: deriveInverse(reindex, store.registrySnapshot()) },
      });
      const registry = store.validationRegistrySnapshot();
      const table = registry.get("projects")!;
      const field = table.columns.find(column => column.name === "title")!;
      const prefix = `schema/index/main/${table.semantic!.tableId}/${field.semantic!.fieldId}/`;
      expect(enumerateCanonicalStateV1(driver, registry).leaves
        .filter(entry => entry.seed.key.startsWith(prefix))).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("rejects repointing an authorized index name to another semantic field", async () => {
    const { store, driver } = await fixture();
    try {
      const operations: ForwardOpT[] = [{ op: "add_index", table: "projects", column: "name" }];
      store.commit({
        intent: "index", summary: "Authorizes the name index.",
        migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) },
      });
      driver.exec('DROP INDEX "idx_projects_name"');
      driver.exec('CREATE INDEX "idx_projects_name" ON "projects"("estimate")');
      expectStateError(() => enumerateCanonicalStateV1(
        driver, store.validationRegistrySnapshot(),
      ));
    } finally {
      store.close();
    }
  });

  it("rejects an exact-form user index without active migration authority", async () => {
    const { store, driver } = await fixture();
    try {
      driver.exec(`CREATE INDEX "idx_projects_name" ON "projects"("name")`);
      expectStateError(() => enumerateCanonicalStateV1(
        driver, store.validationRegistrySnapshot(),
      ));
    } finally {
      store.close();
    }
  });

  it("rejects an unrecognized physical index instead of omitting it from the digest", async () => {
    const { store, driver } = await fixture();
    try {
      driver.exec("CREATE INDEX unexpected_projects_name ON projects(name)");
      expectStateError(() => enumerateCanonicalStateV1(
        driver, store.validationRegistrySnapshot(),
      ));
    } finally {
      store.close();
    }
  });

  it("rejects an unrecognized system index instead of omitting it from the digest", async () => {
    const { store, driver } = await fixture();
    try {
      driver.exec("CREATE INDEX sys.unexpected_settings_key ON settings(key)");
      expectStateError(() => enumerateCanonicalStateV1(
        driver, store.validationRegistrySnapshot(),
      ));
    } finally {
      store.close();
    }
  });

  it("rejects an unrecognized system table instead of omitting it from the digest", async () => {
    const { store, driver } = await fixture();
    try {
      driver.exec("CREATE TABLE sys.unexpected_state(id TEXT PRIMARY KEY)");
      expectStateError(() => enumerateCanonicalStateV1(
        driver, store.validationRegistrySnapshot(),
      ));
    } finally {
      store.close();
    }
  });

  it("detects canonical data that diverges from the persisted Merkle index", async () => {
    const { store, driver, rowId } = await fixture();
    try {
      const registry = store.validationRegistrySnapshot();
      const enumeration = enumerateCanonicalStateV1(driver, registry);
      StateMerkleIndex.createSchema(driver);
      StateMerkleIndex.initialize(driver, enumeration.leaves.map(entry => entry.seed));
      expect(verifyCanonicalStateV1(driver, registry).stateSha256)
        .toBe(enumeration.stateSha256);

      driver.exec("UPDATE projects SET estimate = 99 WHERE id = ?", [rowId]);
      expectStateError(() => verifyCanonicalStateV1(driver, registry));
    } finally {
      store.close();
    }
  });
});
