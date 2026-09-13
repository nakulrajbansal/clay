import { expect, it } from "vitest";
import { ClayStore, deriveInverse, openMemoryDriver, type ForwardOpT } from "../src/index";
import { ProductionStoreAuthority, armProductionAuthorityFailureForTest } from "../src/production-authority";

const opaque = (prefix: string, char: string) => `${prefix}_${char.repeat(26)}`;
async function fixture(prepare?: (store: ClayStore) => void) {
  const driver = await openMemoryDriver();
  driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  const store = ClayStore.fromDriver(driver);
  const operations: ForwardOpT[] = [
    { op: "create_table", table: "people", columns: [{ name: "name", type: "text", required: true }] },
    { op: "create_table", table: "tasks", columns: [
      { name: "title", type: "text", required: true }, { name: "person", type: "text", required: false },
      { name: "due", type: "date", required: false }, { name: "done", type: "boolean", required: false },
    ] },
  ];
  store.commit({ intent: "test fixture", summary: "test fixture", migration: {
    operations, inverse: deriveInverse(operations, store.registrySnapshot()),
  } });
  const person = store.insert("people", { name: "Alex" });
  const row = store.insert("tasks", { title: "Call", person: "Alex", done: false });
  prepare?.(store);
  const authority = ProductionStoreAuthority.adoptLegacy(driver, {
    inventory: { state: "complete", catalogPresent: false, namespaces: [
      { storageKey: "default", userFile: "/user.db", systemFile: "/system.db", kind: "legacy" },
    ] }, storageKey: "default", displayName: "Tasks", shellId: "blank",
    appInstanceId: opaque("app", "a"), generationId: opaque("gen", "b"), namespaceId: opaque("ns", "c"),
    adoptionOperationId: opaque("op", "d"), releaseId: opaque("rel", "e"), nowMs: Date.now(), leaseTtlMs: 60_000,
  });
  return { authority, driver, row, person };
}

it("previews, keeps, replays and rewinds source-bound text conversion through authority", async () => {
  const { authority, row, person } = await fixture();
  try {
    const before = authority.inspectAuthority().target;
    const original = authority.query({ from: "tasks" });
    const previewInput = {
      sourceTable: "tasks", sourceField: "person", targetTable: "people", displayField: "name",
    };
    const previewPromise = authority.previewRelationConversion(previewInput);
    previewInput.sourceField = "title";
    const preview = await previewPromise;
    expect(preview.sourceField).toBe("person");
    expect(preview.authorityTarget).toEqual(before);
    expect(preview.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(authority.inspectAuthority().target).toEqual(before);
    const request = { requestId: authority.createRequestId(), route: "schema.convertTextToRelation",
      payload: { ...preview, cardinality: "one" } };
    const kept = await authority.executeMutation(request);
    expect(kept.result).toMatchObject({ convertedRows: 1, sourceField: "person_source", relationField: "person_link" });
    expect(authority.query({ from: "tasks" })[0]?.person_link).toEqual({ id: person.id, table: "people", label: "Alex" });
    expect((await authority.executeMutation(request)).replayed).toBe(true);
    await authority.executeMutation({ requestId: authority.createRequestId(), route: "timeline.makeLatest", payload: { version: 1 } });
    expect(authority.query({ from: "tasks" })).toEqual(original);
    expect(authority.activeSemanticRegistry().get("tasks")?.reservedColumnNames).toBeUndefined();
    expect((await authority.collectArchiveSnapshot()).format).toBe(5);
  } finally { authority.close(); }
});

it("initializes a durable timezone, validates source selection, and uses navigation CAS", async () => {
  const { authority, row } = await fixture();
  const mutate = (route: string, payload: unknown) => authority.executeMutation({ requestId: authority.createRequestId(), route, payload });
  try {
    const zoneRequest = { requestId: authority.createRequestId(), route: "daily.timeZone", payload: { timeZone: "America/New_York" } };
    expect((await authority.executeMutation(zoneRequest)).result).toBe("America/New_York");
    expect((await authority.executeMutation(zoneRequest)).replayed).toBe(true);
    expect((await mutate("daily.timeZone", { timeZone: "UTC" })).result).toBe("America/New_York");
    expect(() => mutate("daily.timeZone", { timeZone: "+04:00" })).toThrow();
    const table = authority.activeSemanticRegistry().get("tasks")!;
    const field = (name: string) => table.columns.find(column => column.name === name)!.semantic!.fieldId;
    const profile = { schema: 1, enabled: true, profileId: opaque("dsp", "p"), tableId: table.semantic!.tableId,
      labelFieldId: field("title"), dueFieldId: field("due"), completion: { kind: "none" },
      labelSnapshot: "Tasks", dueLabelSnapshot: "Due" };
    const value = { schema: 1, revision: 1, profiles: [profile] };
    expect((await mutate("daily.source", { expectedRevision: 0, value })).result).toMatchObject({ ok: true });
    expect((await mutate("daily.source", { expectedRevision: 0, value })).result).toEqual({ ok: false, current: value });
    await expect(mutate("daily.source", { expectedRevision: 1, value: { ...value, revision: 2,
      profiles: [{ ...profile, dueFieldId: field("title") }],
    } })).rejects.toThrow();
    const reference = { tableId: table.semantic!.tableId, rowId: row.id };
    const navigation = { schema: 1, revision: 1,
      favorites: [{ ...reference, pinnedAt: "2026-09-12T12:00:00.000Z" }],
      recents: [{ ...reference, openedAt: "2026-09-12T12:00:00.000Z" }] };
    expect((await mutate("daily.navigation", { expectedRevision: 0, value: navigation })).result).toMatchObject({ ok: true });
    expect(authority.readSetting("daily_navigation_v1")).toEqual(navigation);
    expect(() => mutate("setting.set", { key: "daily_navigation_v1", value: navigation })).toThrow();
  } finally { authority.close(); }
});

it("does not undo a conversion across any intervening record edit and keeps its historical receipt read-only", async () => {
  const { authority, row } = await fixture();
  try {
    const preview = await authority.previewRelationConversion({ sourceTable: "tasks", sourceField: "person", targetTable: "people", displayField: "name" });
    const request = { requestId: authority.createRequestId(), route: "schema.convertTextToRelation", payload: { ...preview, cardinality: "one" } };
    await authority.executeMutation(request);
    await authority.executeMutation({ requestId: authority.createRequestId(), route: "store.update",
      payload: { table: "tasks", id: String(row.id), patch: { title: "Keep this later edit" } } });
    const before = authority.inspectAuthority().target;
    await expect(authority.executeMutation({ requestId: authority.createRequestId(), route: "schema.undoRelationConversion",
      payload: { conversionRequestId: request.requestId, beforeVersion: preview.atVersion } })).rejects.toThrow(/bounded|intervening/);
    expect(authority.inspectAuthority().target).toEqual(before);
    expect(authority.query({ from: "tasks" })[0]?.title).toBe("Keep this later edit");
    expect(await authority.mutationOutcome(request)).toMatchObject({ status: "recorded", current: false, result: { relationField: "person_link" } });
    await expect(authority.executeMutation(request)).rejects.toThrow(/historical/);
    await expect(authority.mutationOutcome({ ...request, payload: { ...request.payload, matchedRows: 0 } })).rejects.toThrow(/identity|payload/);
  } finally { authority.close(); }
});

it("captures once through authority and bounds Undo to the unchanged captured record", async () => {
  const { authority } = await fixture();
  try {
    const tableId = authority.activeSemanticRegistry().get("tasks")!.semantic!.tableId;
    const request = { requestId: authority.createRequestId(), route: "daily.capture", payload: {
      appInstanceId: authority.inspectAuthority().target.appInstanceId,
      table: "tasks", tableId, row: { title: "Captured", done: false },
    } };
    const receipt = (await authority.executeMutation(request)).result as { id: string; created: Array<{ id: string }> };
    expect(authority.readStore().rowHistory("tasks", receipt.created[0]!.id)).toEqual([]);
    expect((await authority.executeMutation(request)).replayed).toBe(true);
    expect(authority.query({ from: "tasks" })).toHaveLength(2);
    expect(authority.readSetting("quick_capture_last_table_v1")).toBe(tableId);
    const undo = { requestId: authority.createRequestId(), route: "daily.undoCapture", payload: { batchId: receipt.id } };
    expect((await authority.executeMutation(undo)).result).toMatchObject({ undone: true });
    expect((await authority.executeMutation(undo)).replayed).toBe(true);
    expect(authority.query({ from: "tasks" })).toHaveLength(1);
    const second = (await authority.executeMutation({ ...request, requestId: authority.createRequestId() })).result as typeof receipt;
    await authority.asyncStore().update("tasks", second.created[0]!.id, { title: "Edited" }, { requestId: authority.createRequestId() });
    await expect(authority.executeMutation({ ...undo, requestId: authority.createRequestId(), payload: { batchId: second.id } })).rejects.toThrow();
    expect(authority.query({ from: "tasks" }).some(record => record.title === "Edited")).toBe(true);
    await expect(authority.executeMutation({ ...request, requestId: authority.createRequestId(),
      payload: { ...request.payload, tableId: authority.activeSemanticRegistry().get("people")!.semantic!.tableId },
    })).rejects.toThrow();
  } finally { authority.close(); }
});

it("repairs a malformed source library only through an explicit empty-library CAS", async () => {
  const { authority } = await fixture(store => store.setSetting("daily_source_library_v1", { revision: 7, damaged: true }));
  try {
    const clear = { requestId: authority.createRequestId(), route: "daily.source",
      payload: { expectedRevision: 7, value: { schema: 1, revision: 8, profiles: [] } } };
    expect((await authority.executeMutation(clear)).result).toMatchObject({ ok: true, current: clear.payload.value });
    expect(authority.readSetting("daily_source_library_v1")).toEqual(clear.payload.value);
  } finally { authority.close(); }
});

it("rejects stale and rebound conversion previews and rolls back an interrupted Keep", async () => {
  const { authority, row } = await fixture();
  try {
    const preview = await authority.previewRelationConversion({
      sourceTable: "tasks", sourceField: "person", targetTable: "people", displayField: "name",
    });
    const request = { requestId: authority.createRequestId(), route: "schema.convertTextToRelation", payload: { ...preview, cardinality: "one" } };
    await expect(authority.executeMutation({ ...request, payload: { ...request.payload,
      authorityTarget: { ...preview.authorityTarget, appInstanceId: opaque("app", "z") },
    } })).rejects.toThrow();
    await authority.asyncStore().update("tasks", String(row.id), { person: "Someone else" }, { requestId: authority.createRequestId() });
    await expect(authority.executeMutation(request)).rejects.toThrow(/changed|stale|target/i);
    const current = await authority.previewRelationConversion({
      sourceTable: "tasks", sourceField: "person", targetTable: "people", displayField: "name",
    });
    armProductionAuthorityFailureForTest(authority);
    await expect(authority.executeMutation({ requestId: authority.createRequestId(), route: request.route,
      payload: { ...current, cardinality: "one" },
    })).rejects.toThrow();
    expect(authority.query({ from: "tasks" })[0]?.person).toBe("Someone else");
  } finally { authority.close(); }
});
