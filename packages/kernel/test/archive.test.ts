// .clay archives (doc 04 §7): zip round-trip, export -> import equality
// (doc 08 §5), integrity aborts that leave nothing half-swapped, and the
// G15 rule — imported panel blobs are re-validated, never trusted.
import { describe, expect, it } from "vitest";
import {
  ClayStore, crc32, deriveInverse, isFieldId, openDriverFromBytes, registryToJson,
  zipRead, zipWrite, type DbDriver, type ForwardOpT,
} from "../src/index";
import { HEALTH_COMPUTED, seededStore } from "./helpers";

describe("minimal zip", () => {
  it("round-trips entries byte-exact", () => {
    const a = new TextEncoder().encode("hello clay");
    const b = new Uint8Array([0, 1, 2, 255, 254, 253]);
    const zipped = zipWrite([{ name: "a.txt", data: a }, { name: "dir/b.bin", data: b }]);
    const back = zipRead(zipped);
    expect(back.map(e => e.name)).toEqual(["a.txt", "dir/b.bin"]);
    expect([...back[0]!.data]).toEqual([...a]);
    expect([...back[1]!.data]).toEqual([...b]);
  });

  it("detects corruption via crc", () => {
    const zipped = zipWrite([{ name: "x", data: new TextEncoder().encode("payload") }]);
    zipped[35] = zipped[35]! ^ 0xff;   // flip a byte inside the stored data
    expect(() => zipRead(zipped)).toThrowError(/crc|corrupt|zip/i);
    expect(crc32(new Uint8Array([1, 2, 3]))).not.toBe(crc32(new Uint8Array([1, 2, 4])));
  });

  it("rejects incoherent local headers and central-directory bounds", () => {
    const source = zipWrite([{ name: "x", data: new TextEncoder().encode("payload") }]);
    const method = source.slice();
    new DataView(method.buffer, method.byteOffset, method.byteLength).setUint16(8, 8, true);
    expect(() => zipRead(method)).toThrow(/local|method|coher|corrupt/i);

    const name = source.slice();
    name[30] = "y".charCodeAt(0);
    expect(() => zipRead(name)).toThrow(/local|name|coher|corrupt/i);

    const directory = source.slice();
    const eocd = directory.length - 22;
    const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
    view.setUint32(eocd + 12, view.getUint32(eocd + 12, true) - 1, true);
    expect(() => zipRead(directory)).toThrow(/central directory|coher|corrupt/i);
  });
});

async function richStore(): Promise<ClayStore> {
  const store = await seededStore();
  store.commit({
    intent: "health", summary: "Adds health score.", migration: HEALTH_COMPUTED,
    panels: [{
      panel_id: "health_strip", title: "Health",
      placement: { region: "top", order: 0 },
      code: "export default function (clay) { clay.ui.render(h(EmptyState, { label: \"ok\" })); }",
      declared_queries: [{ from: "projects" }], declared_writes: [],
    }],
  });
  const id = String(store.query({ from: "projects" })[0]!.id);
  store.update("projects", id, { owner: "Kim" });   // row_history content too
  return store;
}

function stripSemanticMetadata(store: ClayStore, removeGuard: boolean): void {
  const driver = (store as unknown as { driver: DbDriver }).driver;
  for (const row of driver.select("SELECT table_name, spec_json FROM sys.tables_registry")) {
    const spec = JSON.parse(String(row.spec_json)) as {
      semantic?: unknown; columns: Array<{ semantic?: unknown }>;
    };
    delete spec.semantic;
    for (const column of spec.columns) delete column.semantic;
    driver.exec("UPDATE sys.tables_registry SET spec_json = ? WHERE table_name = ?", [
      JSON.stringify(spec), String(row.table_name),
    ]);
  }
  if (removeGuard)
    driver.exec("DELETE FROM sys.settings WHERE key = 'semantic_registry_v1'");
}

describe("export -> import round trip", () => {
  async function mutateArchive(
    bytes: Uint8Array, mutate: (driver: DbDriver) => void,
  ): Promise<Uint8Array> {
    const parts = zipRead(bytes);
    const user = parts.find(part => part.name === "user.db")!.data;
    const system = parts.find(part => part.name === "system.db")!.data;
    const driver = await openDriverFromBytes(user, system);
    mutate(driver);
    const changed = await driver.exportDatabases();
    driver.close();
    return zipWrite(parts.map(part => part.name === "user.db"
      ? { ...part, data: changed.user }
      : part.name === "system.db" ? { ...part, data: changed.system } : part));
  }

  it("reproduces registry, data, history, panels, and row_history", async () => {
    const original = await richStore();
    original.setCheckpoint(2, "milestone");
    const bytes = await original.exportArchive("test-app");

    const { store: imported, manifest, invalidPanels } =
      await ClayStore.importArchive(bytes);
    expect(manifest).toMatchObject({ format: 4, app: "test-app", versions: 2 });
    expect(invalidPanels).toEqual([]);

    expect(registryToJson(imported.registrySnapshot()))
      .toBe(registryToJson(original.registrySnapshot()));
    expect(JSON.stringify(imported.dumpTable("projects")))
      .toBe(JSON.stringify(original.dumpTable("projects")));
    expect(imported.history()).toEqual(original.history());
    expect(imported.livePanels()).toEqual(original.livePanels());
    expect(imported.rowHistoryCount()).toBe(original.rowHistoryCount());

    // the imported store is fully operational
    imported.insert("projects", { name: "Denali" });
    expect(imported.query({ from: "projects" })).toHaveLength(4);
    original.close();
    imported.close();
  });

  it("rejects non-archives and unknown formats", async () => {
    await expect(ClayStore.importArchive(new Uint8Array([1, 2, 3])))
      .rejects.toThrowError(/zip/i);
    const fake = zipWrite([
      { name: "manifest.json", data: new TextEncoder().encode(`{"format": 99}`) },
      { name: "user.db", data: new Uint8Array(0) },
      { name: "system.db", data: new Uint8Array(0) },
    ]);
    await expect(ClayStore.importArchive(fake))
      .rejects.toThrowError(/unsupported archive format/);
  });

  it("rejects an oversized manifest before JSON parsing", async () => {
    const source = await seededStore();
    const parts = zipRead(await source.exportArchive("manifest-limit"));
    source.close();
    const manifest = JSON.parse(new TextDecoder().decode(
      parts.find(part => part.name === "manifest.json")!.data));
    const oversized = zipWrite(parts.map(part => part.name === "manifest.json"
      ? { ...part, data: new TextEncoder().encode(JSON.stringify({
          ...manifest, app: "x".repeat(70_000),
        })) }
      : part));
    await expect(ClayStore.importArchive(oversized)).rejects.toMatchObject({ code: "E_LIMIT" });
  });

  it("continues to import legacy format-1 archives", async () => {
    const source = await richStore();
    const parts = zipRead(await source.exportArchive("legacy"));
    const legacy = zipWrite(parts.map(part => part.name === "manifest.json"
      ? { ...part, data: new TextEncoder().encode(JSON.stringify({
          ...JSON.parse(new TextDecoder().decode(part.data)), format: 1,
        })) }
      : part));
    const { store, manifest } = await ClayStore.importArchive(legacy);
    expect(manifest.format).toBe(1);
    expect(store.query({ from: "projects" })).toHaveLength(3);
    source.close(); store.close();
  });

  it("backfills a genuinely pre-semantic format-2 archive locally", async () => {
    const source = await richStore();
    stripSemanticMetadata(source, true);
    const parts = zipRead(await source.exportArchive("legacy-v2"));
    const legacy = zipWrite(parts.map(part => part.name === "manifest.json"
      ? { ...part, data: new TextEncoder().encode(JSON.stringify({
          ...JSON.parse(new TextDecoder().decode(part.data)), format: 2,
        })) }
      : part));
    const { store, manifest } = await ClayStore.importArchive(legacy);
    expect(manifest.format).toBe(2);
    expect(store.semanticSchemaTrace().fields.every(field => isFieldId(field.fieldId))).toBe(true);
    source.close(); store.close();
  });

  it("rejects a format-3 archive whose semantic registry was stripped", async () => {
    const source = await richStore();
    stripSemanticMetadata(source, false);
    const archive = await source.exportArchive("broken-semantic");
    await expect(ClayStore.importArchive(archive)).rejects.toThrow(/semantic/i);
    source.close();
  });

  it("format 4 preserves inactive rollback values across export and import", async () => {
    const source = await richStore();
    const ops = [{ op: "add_column" as const, table: "projects",
      column: { name: "private_note", type: "text" as const, required: false } }];
    source.commit({ intent: "note", summary: "Adds note.",
      migration: { operations: ops, inverse: deriveInverse(ops, source.registrySnapshot()) } });
    const id = String(source.query({ from: "projects" })[0]!.id);
    source.update("projects", id, { private_note: "must survive" });
    source.rollbackTo(2, { truncate: true });
    source.insert("projects", { name: "Added while note was inactive" });
    const driver=(source as unknown as {driver:DbDriver}).driver;
    driver.exec("INSERT INTO sys.inactive_cells VALUES(?,?,?)",["projects","private_note",id]);
    expect(source.verifyIntegrity()).toContain("inactive-cell marker does not point to a NULL cell");
    driver.exec("DELETE FROM sys.inactive_cells WHERE row_id=?",[id]);

    const { store, manifest } = await ClayStore.importArchive(
      await source.exportArchive("retained"));
    expect(manifest.format).toBe(4);
    const restored = [...ops, { op: "backfill" as const, table: "projects",
      column: "private_note", value: "new default" }];
    store.commit({ intent: "restore note", summary: "Restores note.",
      migration: { operations: restored, inverse: deriveInverse(restored, store.registrySnapshot()) } });
    expect(store.query({ from: "projects" })[0]!.private_note).toBe("must survive");
    const later = store.query({ from: "projects" }).find(row =>
      row.name === "Added while note was inactive");
    expect(later?.private_note).toBe("new default");
    source.close(); store.close();
  });

  it("rolls back an existing target when archive copy fails mid-install", async () => {
    const source = await richStore();
    const target = await seededStore();
    const targetBefore = JSON.stringify(target.dumpTable("projects"));
    const targetRegistry = registryToJson(target.registrySnapshot());
    const realDriver = (target as unknown as { driver: DbDriver }).driver;
    let injected = false;
    const failingDriver = new Proxy(realDriver, {
      get(driver, property) {
        if (property === "exec") return (sql: string, params?: Parameters<DbDriver["exec"]>[1]) => {
          if (!injected && sql.startsWith('INSERT INTO main."projects"')) {
            injected = true;
            throw new Error("injected archive copy failure");
          }
          return driver.exec(sql, params);
        };
        const value = Reflect.get(driver, property);
        return typeof value === "function" ? value.bind(driver) : value;
      },
    }) as DbDriver;
    await expect(ClayStore.importArchive(
      await source.exportArchive("replacement"), async () => failingDriver,
    )).rejects.toThrow(/injected archive copy failure/i);
    expect(injected).toBe(true);
    expect(JSON.stringify(target.dumpTable("projects"))).toBe(targetBefore);
    expect(registryToJson(target.registrySnapshot())).toBe(targetRegistry);
    expect(target.query({ from: "projects" })).toHaveLength(3);
    source.close(); target.close();
  });

  it("aborts on integrity failure (mixed-up databases)", async () => {
    const a = await richStore();
    const empty = await ClayStore.openMemory();
    const aBytes = await a.exportArchive("a");
    const emptyBytes = await empty.exportArchive("empty");
    const aParts = zipRead(aBytes);
    const emptyParts = zipRead(emptyBytes);
    // registry (system.db) from A, but user.db from the empty store:
    const frankenstein = zipWrite([
      aParts.find(e => e.name === "manifest.json")!,
      { name: "user.db", data: emptyParts.find(e => e.name === "user.db")!.data },
      { name: "system.db", data: aParts.find(e => e.name === "system.db")!.data },
    ]);
    await expect(ClayStore.importArchive(frankenstein))
      .rejects.toThrowError(/integrity/);
    a.close();
    empty.close();
  });

  it("rejects physical user columns missing from the registry", async () => {
    const store = await richStore();
    try {
      const driver = (store as unknown as { driver: DbDriver }).driver;
      driver.exec(`ALTER TABLE "projects" ADD COLUMN "orphan_note" TEXT`);

      expect(store.verifyIntegrity()).toContain(
        "'projects' has unregistered physical column 'orphan_note'",
      );
    } finally { store.close(); }
  });

  it("rejects format-3 orphan tables, registry key mismatches, and manifest counts", async () => {
    const orphan = await richStore();
    const orphanDriver = (orphan as unknown as { driver: DbDriver }).driver;
    orphanDriver.exec("DELETE FROM sys.tables_registry WHERE table_name = 'projects'");
    await expect(ClayStore.importArchive(await orphan.exportArchive("orphan")))
      .rejects.toThrow(/physical table|manifest table count|unsafe schema|unexpected table/i);
    orphan.close();

    const mismatch = await richStore();
    const mismatchDriver = (mismatch as unknown as { driver: DbDriver }).driver;
    mismatchDriver.exec(
      "UPDATE sys.tables_registry SET table_name = 'wrong_key' WHERE table_name = 'projects'",
    );
    await expect(ClayStore.importArchive(await mismatch.exportArchive("mismatch")))
      .rejects.toThrow(/registry key|unsafe schema|unexpected table/i);
    mismatch.close();

    const count = await richStore();
    const parts = zipRead(await count.exportArchive("count"));
    const badCount = zipWrite(parts.map(part => part.name === "manifest.json"
      ? { ...part, data: new TextEncoder().encode(JSON.stringify({
          ...JSON.parse(new TextDecoder().decode(part.data)), tables: 999,
        })) }
      : part));
    await expect(ClayStore.importArchive(badCount)).rejects.toThrow(/manifest table count/i);
    count.close();
  });

  it("removes legacy provider credentials before archive export and import", async () => {
    const source = await richStore();
    source.setSetting("byo_api_key", "must-never-leave-this-device");
    source.setSetting("backend_url", "https://backend.invalid");
    source.setSetting("clay_backend_url", "https://legacy.invalid");
    const bytes = await source.exportArchive("credential-free");
    expect(source.getSetting("byo_api_key")).toBeUndefined();
    expect(source.getSetting("backend_url")).toBeUndefined();
    expect(source.getSetting("clay_backend_url")).toBeUndefined();
    const parts = zipRead(bytes);
    const exported = await openDriverFromBytes(
      parts.find(part => part.name === "user.db")!.data,
      parts.find(part => part.name === "system.db")!.data,
    );
    expect(exported.select(
      "SELECT key FROM sys.settings WHERE key IN ('byo_api_key','backend_url','clay_backend_url')",
    )).toEqual([]);
    exported.close();
    const imported = await ClayStore.importArchive(bytes);
    expect(imported.store.getSetting("byo_api_key")).toBeUndefined();
    source.close(); imported.store.close();
  });

  it("does not export private activity counters", async () => {
    const source = await richStore();
    source.recordPrivateMetric({ type: "trust_surface_opened", surface: "shape_map" });
    expect(source.privateMetricsSummary().trust.shapeMapOpened).toBe(1);
    const imported = await ClayStore.importArchive(await source.exportArchive("private"));
    expect(imported.store.privateMetricsSummary().trust.shapeMapOpened).toBe(0);
    source.close(); imported.store.close();
  });

  it("accepts legacy format 3 active-table counts after rewind", async () => {
    const store = await richStore();
    store.rollbackTo(0);
    const parts = zipRead(await store.exportArchive("legacy-rewind"));
    const legacy = zipWrite(parts.map(part => {
      if (part.name !== "manifest.json") return part;
      const manifest = JSON.parse(new TextDecoder().decode(part.data)) as Record<string, unknown>;
      delete manifest.attachments;
      return { ...part, data: new TextEncoder().encode(JSON.stringify({
        ...manifest, format: 3, tables: 0,
      })) };
    }));
    await expect(ClayStore.importArchive(legacy)).resolves.toMatchObject({ invalidPanels: [] });
    store.close();
  });

  it("rejects executable SQLite objects and invalid enabled automations before install", async () => {
    const source = await richStore();
    const bytes = await source.exportArchive("hostile-schema");
    const withTrigger = await mutateArchive(bytes, driver => {
      driver.exec(`CREATE TRIGGER hostile_trigger AFTER UPDATE ON projects
        BEGIN UPDATE projects SET owner = 'attacker'; END`);
    });
    await expect(ClayStore.importArchive(withTrigger)).rejects.toThrow(/trigger|schema object/i);

    const withAutomation = await mutateArchive(bytes, driver => {
      driver.exec(`INSERT INTO sys.automations(
        id, definition_json, created_at, updated_at, last_event_seq)
        VALUES (?, ?, ?, ?, 0)`, [
        "auto_018f0000000070008000000000000001",
        JSON.stringify({ id: "auto_018f0000000070008000000000000001",
          name: "Hostile", enabled: true,
          trigger: { kind: "manual", table: "projects", conditions: [] },
          actions: [{ kind: "set_fields", values: {
            missing: { source: "literal", value: "x" },
          } }] }),
        "2026-09-02T00:00:00.000Z", "2026-09-02T00:00:00.000Z",
      ]);
    });
    await expect(ClayStore.importArchive(withAutomation)).rejects.toThrow(/automation/i);
    source.close();
  });

  it("rejects duplicate or unexpected archive entries", async () => {
    const source = await richStore();
    const parts = zipRead(await source.exportArchive("shape"));
    expect(() => ClayStore.parseArchive(zipWrite([...parts, parts[0]!]))).toThrow(/entries|duplicate/i);
    expect(() => ClayStore.parseArchive(zipWrite([...parts,
      { name: "payload.bin", data: new Uint8Array([1]) }]))).toThrow(/entries|unexpected/i);
    source.close();
  });

  it("preserves a legitimate legacy user table named clay_attachments", async () => {
    const source = await ClayStore.openMemory();
    const operations: ForwardOpT[] = [{ op: "create_table", table: "clay_attachments",
      columns: [{ name: "label", type: "text", required: true }] }];
    source.commit({ intent: "legacy", summary: "Legacy user table.",
      migration: { operations, inverse: deriveInverse(operations, source.registrySnapshot()) } });
    source.insert("clay_attachments", { label: "user-owned" });
    const imported = await ClayStore.importArchive(await source.exportArchive("legacy"));
    expect(imported.store.query({ from: "clay_attachments", select: ["label"] }))
      .toEqual([{ label: "user-owned" }]);
    source.close(); imported.store.close();
  });

  it("re-validates imported panel blobs (G15)", async () => {
    const store = await seededStore();
    store.commit({
      intent: "hostile", summary: "Adds a hostile panel.", migration: null,
      panels: [{
        panel_id: "sneaky_panel", title: "Sneaky",
        placement: { region: "main", order: 0 },
        // commit() does not validate — exactly the G15 scenario
        code: "export default function (clay) { fetch('https://evil.example'); }",
        declared_queries: [], declared_writes: [],
      }],
    });
    const bytes = await store.exportArchive("hostile");
    await expect(ClayStore.importArchive(bytes)).rejects.toThrow(/invalid panel/i);
    store.close();
  });
});
