import { expect, it, vi } from "vitest";
import { WorkerClient } from "../src/app/worker-client";
import { ClayStore, deriveInverse, openMemoryDriver, type ForwardOpT } from "../../kernel/src/index";
import { ProductionStoreAuthority } from "../../kernel/src/production-authority";
import { inspectAuthenticatedArchiveV5Header } from "../../kernel/src/archive-authentication";
import { BackupPublicationRequestV1, buildAutomaticBackupFileName } from "@clay/kernel/backup";

vi.mock("../src/app/backup-trust-store.browser", async () => {
  const vault = new (await import("./helpers/memory-backup-trust")).MemoryBackupTrustStore();
  return { IndexedDbBackupTrustRecordStore: function () { return vault; } };
});

// The actual client, message handler, SQLite catalog, authority, shadow runner,
// request journal and projections execute. Only browser acquisition is replaced.
it("executes Daily Home and relation Preview/Keep/replay through the production worker protocol", async () => {
  const driver = await openMemoryDriver();
  driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  const store = ClayStore.fromDriver(driver);
  const operations: ForwardOpT[] = [
    { op: "create_table", table: "people", columns: [{ name: "name", type: "text", required: true }] },
    { op: "create_table", table: "tasks", columns: [
      { name: "title", type: "text", required: true }, { name: "person", type: "text", required: false },
      { name: "due", type: "date", required: false },
    ] },
  ];
  store.commit({ intent: "Fixture", summary: "Fixture", migration: {
    operations, inverse: deriveInverse(operations, store.registrySnapshot()),
  } });
  store.insert("people", { name: "Alex" });
  const existing = store.insert("tasks", { title: "Call", person: "Alex", due: "2026-01-01" });
  store.recordSampleRowProvenance([]);
  const id = (prefix: string, char: string) => `${prefix}_${char.repeat(26)}`;
  const authority = ProductionStoreAuthority.adoptLegacy(driver, {
    inventory: { state: "complete", catalogPresent: false, namespaces: [
      { storageKey: "default", userFile: "/user.db", systemFile: "/system.db", kind: "legacy" },
    ] }, storageKey: "default", displayName: "Tasks", shellId: "blank",
    appInstanceId: id("app", "a"), generationId: id("gen", "b"), namespaceId: id("ns", "c"),
    adoptionOperationId: id("op", "d"), releaseId: id("rel", "e"), nowMs: Date.now(), leaseTtlMs: 60_000,
  });
  vi.spyOn(ProductionStoreAuthority, "bootBrowser").mockResolvedValue(authority);
  const requests: Array<{ id: number; op: string; requestId?: string }> = [];
  let drop: string | null = null;
  let dropped = false;
  const scope = { onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: (data: { id: number; ok: boolean }) => {
      if (data.ok && requests.slice().reverse().find(request => request.id === data.id)?.op === drop) {
        drop = null; dropped = true; return;
      }
      queueMicrotask(() => transport.onmessage?.({ data: structuredClone(data) } as MessageEvent));
    } };
  const transport = { onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: (data: { id: number; op: string; requestId?: string }, transfer: Transferable[] = []) => {
      requests.push(structuredClone(data));
      const ports = transfer.filter(item => item instanceof MessagePort);
      queueMicrotask(() => scope.onmessage?.({ data: structuredClone(data), ports } as unknown as MessageEvent));
    }, terminate: () => {} };
  vi.stubGlobal("self", scope);
  let client = new WorkerClient(transport as unknown as Worker);
  try {
    await import("../src/worker/db-worker");
    await client.boot({ requestedAppId: null, appCache: [] });
    const tables = await client.registryTables();
    const task = tables.find(table => table.name === "tasks")!;
    const tableId = task.semantic!.tableId;
    const field = (name: string) => task.columns.find(column => column.name === name)!.semantic!.fieldId;
    await client.initializeDailyHomeTimeZone("America/New_York", client.createMutationContext());
    const library = { schema: 1 as const, revision: 1, profiles: [{ schema: 1 as const, enabled: true,
      profileId: id("dsp", "p"), tableId, labelFieldId: field("title"), dueFieldId: field("due"),
      labelSnapshot: "Tasks", dueLabelSnapshot: "Due", completion: { kind: "none" as const } }] };
    expect(await client.compareAndSetDailySource(0, library, client.createMutationContext())).toMatchObject({ ok: true });
    await client.rememberDailyRecordOpened(tableId, String(existing.id));
    await client.toggleDailyFavorite(tableId, String(existing.id));
    const home = await client.dailyHome();
    expect(JSON.stringify(home)).toContain("Call");
    expect(await client.getSetting("daily_time_zone_v1")).toBe("America/New_York");
    expect(await client.getSetting("daily_navigation_v1")).toMatchObject({ revision: 2 });

    const capture = client.createMutationContext();
    drop = "dailyHomeQuickCapture";
    const lostCapture = client.quickCapture("tasks", { title: "Captured" }, tableId, capture, id("app", "a")).catch(error => error);
    await vi.waitFor(() => expect(dropped).toBe(true));
    client = new WorkerClient(transport as unknown as Worker);
    expect(await lostCapture).toMatchObject({ code: "E_INTERNAL", message: expect.stringContaining("outcome is unknown") });
    await client.boot({ requestedAppId: null, appCache: [] });
    const receipt = await client.quickCapture("tasks", { title: "Captured" }, tableId, capture, id("app", "a"));
    expect(authority.query({ from: "tasks" })).toHaveLength(2);
    const undo = client.createMutationContext();
    expect(await client.undoQuickCapture(receipt.id, undo)).toMatchObject({ undone: true });
    expect(await client.undoQuickCapture(receipt.id, undo)).toMatchObject({ undone: true });
    expect(authority.query({ from: "tasks" })).toHaveLength(1);
    const capturedOutcome = await client.mutationOutcome("daily.capture", { appInstanceId: id("app", "a"), table: "tasks", row: { title: "Captured" }, tableId }, capture);
    expect(capturedOutcome).toMatchObject({ status: "recorded", current: false, result: { id: receipt.id } });
    await expect(client.mutationOutcome("daily.capture", { appInstanceId: id("app", "a"), table: "tasks", row: { title: "Changed" }, tableId }, capture)).rejects.toThrow(/identity|payload/);
    await expect(client.quickCapture("tasks", { title: "Wrong app" }, tableId, client.createMutationContext(), id("app", "z"))).rejects.toThrow(/another app/);

    const cancelled = client.createMutationContext();
    const cancellationPayload = { appInstanceId: id("app", "a"), table: "tasks", tableId, row: { title: "Delayed cancelled capture" } };
    drop = "cancelPresentation"; dropped = false;
    const lostCancellation = client.cancelPresentation("daily.capture", cancellationPayload, cancelled).catch(error => error);
    await vi.waitFor(() => expect(dropped).toBe(true));
    client = new WorkerClient(transport as unknown as Worker);
    expect(await lostCancellation).toMatchObject({ message: expect.stringContaining("outcome is unknown") });
    await client.boot({ requestedAppId: null, appCache: [] });
    expect(await client.cancelPresentation("daily.capture", cancellationPayload, cancelled)).toEqual({ status: "cancelled" });
    await expect(client.quickCapture("tasks", cancellationPayload.row, tableId, cancelled, id("app", "a"))).rejects.toThrow(/cancelled/);
    expect(await client.mutationOutcome("daily.capture", cancellationPayload, cancelled)).toEqual({ status: "cancelled" });
    expect(authority.query({ from: "tasks" })).toHaveLength(1);

    const preview = await client.previewRelationConversion({ sourceTable: "tasks", sourceField: "person", targetTable: "people", displayField: "name" });
    expect(preview.authorityTarget).toEqual(authority.inspectAuthority().target);
    const keep = client.createMutationContext();
    const converted = await client.convertTextToRelation({ ...preview, cardinality: "one" }, keep);
    expect(converted.convertedRows).toBe(1);
    expect(await client.convertTextToRelation({ ...preview, cardinality: "one" }, keep)).toEqual(converted);
    expect(authority.query({ from: "tasks" })[0]?.person_link).toMatchObject({ table: "people", label: "Alex" });
    const undoConversion = client.createMutationContext();
    expect(await client.undoRelationConversion(keep.requestId, preview.atVersion, undoConversion)).toMatchObject({ undone: true });
    expect(await client.undoRelationConversion(keep.requestId, preview.atVersion, undoConversion)).toMatchObject({ undone: true });
    expect(authority.query({ from: "tasks" })[0]?.person).toBe("Alex");
    expect(requests.filter(request => request.op === "dailyHomeQuickCapture" && request.requestId === capture.requestId).map(request => request.requestId))
      .toEqual([capture.requestId, capture.requestId]);
    // Keys never travel over the ordinary DB-worker transport. Authenticated
    // readback uses a separate single-use verifier port before ZIP parsing.
    await client.applyBatch("Edit a record", [{ kind: "update", table: "tasks", id: String(existing.id), patch: { title: "Call later" } }], client.createMutationContext());
    expect(await client.backupRecords()).toEqual([]);
    expect((await client.backupSelection()).selected.target).toEqual(authority.inspectAuthority().target);
    expect(await client.backupTrustStatus()).toEqual({ status: "not_enrolled" });
    const enrollment = await client.beginBackupTrustEnrollment();
    expect(await client.confirmBackupTrustEnrollment(enrollment.enrollmentId, enrollment.bytes.slice().buffer))
      .toMatchObject({ status: "ready" });
    const archive = await client.exportArchive();
    expect(inspectAuthenticatedArchiveV5Header(new Uint8Array(archive.bytes)).archiveFormat).toBe(5);
    expect(requests.some(request => ["beginBackupTrustEnrollment", "confirmBackupTrustEnrollment", "importRecoveryKit"].includes(request.op)))
      .toBe(false);
    const prepared = await client.prepareAutomaticBackup({ schema: 1, targetId: id("tgt", "f"),
      appInstanceId: authority.inspectAuthority().target.appInstanceId, adapter: "browser_directory",
      adapterCertificationId: id("btc", "g"), authorizedAt: "2026-01-01T00:00:00.000Z" }, "backup_now");
    const run = prepared.run;
    const publication = BackupPublicationRequestV1.parse({ schema: 1, expected: run.expected, fence: run.fence, artifact: {
      schema: 1, backupId: run.backupId, generationId: run.generationId, targetId: run.target.targetId,
      evidence: run.expected.target, fileName: buildAutomaticBackupFileName(run.fileLabel, run.generationId, run.createdAt),
      createdAt: run.createdAt, validatedAt: new Date().toISOString(), shapeHead: run.archive.shapeHead,
      shapeCurrent: run.archive.shapeCurrent, archiveFormat: 5, byteLength: run.archive.byteLength,
      archiveSha256: run.archive.archiveSha256, authentication: run.archive.authentication,
      adapterCertificationId: run.target.adapterCertificationId,
    } });
    await expect(client.publishBackup(publication)).rejects.toThrow(/read-back/);
    expect(await client.validateBackupStage(prepared.bytes.slice(0), run.expected.target)).toMatchObject({ status: "valid" });
    drop = "publishBackup"; dropped = false;
    void client.publishBackup(publication).catch(() => {}); // Owned injected response loss; durable receipt is asserted below.
    await vi.waitFor(() => expect(dropped).toBe(true));
    expect(await client.backupRecords()).toHaveLength(1);
    expect((await client.recoveryCandidates()).length).toBeGreaterThan(0);
    client = new WorkerClient(transport as unknown as Worker);
    const retry = await client.prepareAutomaticBackup(run.target, "retry");
    expect(retry.run.backupId).toBe(run.backupId);
    expect(await client.validateBackupStage(retry.bytes, run.expected.target)).toMatchObject({ status: "valid" });
    expect(await client.publishBackup(publication)).toMatchObject({ publication: "already_published" });
    expect(await client.publishBackup(publication)).toMatchObject({ publication: "already_published" });
    expect(await client.backupRecords()).toHaveLength(1);
  } finally {
    await client.shutdown().catch(() => {});
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
}, 60_000);
