import { afterEach, expect, it, vi } from "vitest";
import { ClayStore, deriveInverse, openMemoryDriver, type ForwardOpT } from "../src/index";
import { ProductionStoreAuthority, armProductionAuthorityFailureForTest } from "../src/production-authority";

afterEach(() => vi.useRealTimers());
const id = (prefix: string, char: string) => `${prefix}_${char.repeat(26)}`;
async function fixture(rows = 1) {
  if (rows > 1) { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-13T12:00:00.000Z")); }
  const driver = await openMemoryDriver(); driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  const store = ClayStore.fromDriver(driver);
  const operations: ForwardOpT[] = [{ op: "create_table", table: "tasks", columns: [
    { name: "title", type: "text", required: true }, { name: "due", type: "date", required: true }, { name: "done", type: "boolean", required: false },
  ] }];
  store.commit({ intent: "Fixture", summary: "Fixture", migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) } });
  for (let index = 0; index < rows; index++) store.insert("tasks", { title: `Task ${index}`, due: "2026-01-01", done: false });
  store.recordSampleRowProvenance([]);
  const authority = ProductionStoreAuthority.adoptLegacy(driver, { inventory: { state: "complete", catalogPresent: false,
    namespaces: [{ storageKey: "default", userFile: "/user.db", systemFile: "/system.db", kind: "legacy" }] }, storageKey: "default",
    displayName: "Tasks", shellId: "blank", appInstanceId: id("app", "a"), generationId: id("gen", "b"), namespaceId: id("ns", "c"),
    adoptionOperationId: id("op", "d"), releaseId: id("rel", "e"), nowMs: Date.now(), leaseTtlMs: 60_000 });
  await authority.executeMutation({ requestId: authority.createRequestId(), route: "daily.timeZone", payload: { timeZone: "America/New_York" } });
  const table = authority.activeSemanticRegistry().get("tasks")!;
  const field = (name: string) => table.columns.find(column => column.name === name)!.semantic!.fieldId;
  const read = await authority.dailyPresentation();
  await authority.executeMutation({ requestId: authority.createRequestId(), route: "daily.source", payload: { expectedRevision: 0,
    value: { schema: 1, revision: 1, profiles: [{ schema: 1, profileId: id("dsp", "p"), tableId: table.semantic!.tableId,
      enabled: true, labelFieldId: field("title"), dueFieldId: field("due"), completion: { kind: "boolean", fieldId: field("done"), completeValue: true } }] },
    review: { authorityTarget: read.authorityTarget, basis: read.snapshot.basis, snapshotDigest: read.snapshot.snapshotDigest } } });
  return { authority, driver };
}
async function action(authority: ProductionStoreAuthority, kind: "complete" | "snooze" | "dismiss", untilLocalDate?: string) {
  const read = await authority.dailyPresentation();
  const item = read.snapshot.sources.find(source => source.sourceId === "due_record")!.page.items[0]!;
  return { requestId: authority.createRequestId(), route: "daily.inbox", payload: { action: kind, item,
    review: { authorityTarget: read.authorityTarget, basis: read.snapshot.basis, snapshotDigest: read.snapshot.snapshotDigest },
    ...(untilLocalDate ? { untilLocalDate } : {}) } };
}

it("completes through exact projection/source CAS and bounds reversible disposition plus record effects", async () => {
  const { authority, driver } = await fixture();
  try {
    const request = await action(authority, "complete");
    const completed = await authority.executeMutation(request);
    expect(authority.query({ from: "tasks" })[0]?.done).toBe(true);
    expect((await authority.executeMutation(request)).replayed).toBe(true);
    expect(driver.select("SELECT * FROM sys.inbox_dispositions")).toHaveLength(1);
    expect((await authority.dailyHome()).sources.find(source => source.sourceId === "due_record")!.page.items).toHaveLength(0);
    const undo = { requestId: authority.createRequestId(), route: "daily.undoInbox", payload: {
      actionRequestId: request.requestId, actionPayload: request.payload, authorityTarget: completed.evidence } };
    expect((await authority.executeMutation(undo)).result).toMatchObject({ undone: true });
    expect((await authority.executeMutation(undo)).replayed).toBe(true);
    expect(authority.query({ from: "tasks" })[0]?.done).toBe(false);
    expect((await authority.dailyHome()).sources.find(source => source.sourceId === "due_record")!.page.items).toHaveLength(1);
    expect((await authority.collectArchiveSnapshot()).format).toBe(5);
    await expect(authority.executeMutation({ ...request, requestId: authority.createRequestId() })).rejects.toThrow(/source|projection|intervening/);
  } finally { authority.close(); }
});

it("rolls back first disposition-table creation on a fault, then dismisses without hiding older page work", async () => {
  const { authority, driver } = await fixture(22);
  try {
    const request = await action(authority, "dismiss"); const before = authority.inspectAuthority().target;
    armProductionAuthorityFailureForTest(authority);
    await expect(authority.executeMutation(request)).rejects.toThrow();
    expect(driver.select("SELECT name FROM sys.sqlite_master WHERE name='inbox_dispositions'")).toHaveLength(0);
    expect(authority.inspectAuthority().target).toEqual(before);
    expect(await authority.cancelPresentation(request)).toEqual({ status: "failed" });
    const hidden = new Set<string>();
    for (let index = 0; index < 3; index++) {
      const next = await action(authority, "dismiss"); hidden.add(next.payload.item.sourceKey);
      await authority.executeMutation(next);
    }
    const page = (await authority.dailyHome()).sources.find(source => source.sourceId === "due_record")!.page;
    expect(page.items).toHaveLength(19);
    expect(page.items.some(item => hidden.has(item.sourceKey))).toBe(false);
    expect(page.counts.sourceOccurrences).toEqual({ kind: "exact", total: 19 });
    expect(authority.query({ from: "tasks", limit: 100 })).toHaveLength(22);
  } finally { authority.close(); }
});

it("snoozes to the reviewed local midnight across DST and rejects stale or rebound action identities", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-01T04:00:00.000Z"));
  const { authority } = await fixture();
  try {
    const request = await action(authority, "snooze", "2026-11-02");
    const kept = await authority.executeMutation(request);
    expect(kept.result).toMatchObject({ disposition: { until: "2026-11-02T05:00:00.000Z", timeZone: "America/New_York", localDate: "2026-11-02" } });
    expect((await authority.dailyHome()).sources.find(source => source.sourceId === "due_record")!.page.items).toHaveLength(0);
    const undo = { requestId: authority.createRequestId(), route: "daily.undoInbox", payload: {
      actionRequestId: request.requestId, actionPayload: request.payload, authorityTarget: kept.evidence } };
    await authority.asyncStore().update("tasks", String(authority.query({ from: "tasks" })[0]!.id), { title: "Later edit" }, { requestId: authority.createRequestId() });
    await expect(authority.executeMutation(undo)).rejects.toThrow(/bounded|intervening/);
    expect(await authority.cancelPresentation(undo)).toEqual({ status: "cancelled" });
    const current = await action(authority, "dismiss");
    await expect(authority.executeMutation({ ...current, payload: { ...current.payload, item: { ...current.payload.item, sourceGeneration: id("gen", "z") } } })).rejects.toThrow(/item|projection|source/);
  } finally { authority.close(); }
});
