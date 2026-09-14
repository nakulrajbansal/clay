import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AuthorityGraph, AuthorityReferences } from "../src/authority-graph";
import { DeviceCatalog } from "../src/device-catalog";
import { DeviceCatalog as OriginalCatalog } from "./oracles/device-catalog";
import { exportAuthorityArchiveV5, importAuthenticatedAuthorityArchive as originalImport } from "./oracles/archive-authority";
import { importAuthenticatedAuthorityArchive } from "../src/archive-authority";
import { sealAuthenticatedArchiveV5 } from "../src/archive-authentication";
import { openMemoryDriver, type DbDriver } from "../src/db";
import { authoritativeArchiveSource, committedAuthorityArchiveSource, appendUnrelatedCatalogApp, rewriteAuthority } from "./authority-graph-fixtures";
import { expectedCatalogSchemaObjects } from "../src/device-catalog";
import { encodeAuthorityIdBytes } from "../src/production-operation-id";
import { buildAutomaticBackupFileName } from "../src/backup";

// Synthetic keys only. No owner/credential store is consulted by this packet.
const key = new Uint8Array(32).fill(61);
const header = { authenticationVersion: 1 as const, archiveFormat: 5 as const,
  contentType: "application/vnd.clay.archive+zip" as const, keyId: new Uint8Array(16).fill(42),
  seriesId: new Uint8Array(16).fill(43), generation: 1n };
const seal = (bytes: Uint8Array) => sealAuthenticatedArchiveV5(bytes, key, header);
async function outcome(run: () => unknown | Promise<unknown>) {
  try { return { ok: true, value: await run() }; }
  catch (error) { const e = error as { code?: string; message: string }; return { ok: false, code: e.code, message: e.message }; }
}
async function copyCatalog(source: DbDriver) {
  const copy = await openMemoryDriver();
  copy.exec("ATTACH DATABASE ':memory:' AS catalog");
  for (const table of source.select("SELECT name,sql FROM catalog.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
    const name = String(table.name);
    if (!/^[a-z_]+$/.test(name)) throw new Error("unexpected fixture table");
    copy.exec(String(table.sql).replace(/^CREATE TABLE /, "CREATE TABLE catalog."));
    for (const row of source.select(`SELECT * FROM catalog.${name}`)) {
      const cols = Object.keys(row);
      if (cols.some(col => !/^[a-z_][a-z_0-9]*$/.test(col))) throw new Error("unexpected fixture column");
      copy.exec(`INSERT INTO catalog.${name}(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, cols.map(col => row[col]!));
    }
  }
  return copy;
}
type Source = Awaited<ReturnType<typeof committedAuthorityArchiveSource>>;
let source: Source;
let archive: Uint8Array;
beforeAll(async () => {
  source = await committedAuthorityArchiveSource();
  appendUnrelatedCatalogApp(source.driver, source.catalog);
  archive = await exportAuthorityArchiveV5(await source.store.exportArchive("Field Service"), source.driver);
});
afterAll(() => source?.store.close());

describe("independent pre-refactor AuthorityGraph differential", () => {
  it("uses one worker-owned graph from both production adapters, never from the frozen oracles", () => {
    expect(typeof AuthorityGraph).toBe("function");
    for (const name of ["device-catalog", "archive-authority"]) {
      expect(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8").includes('from "./authority-graph"')).toBe(true);
      expect(readFileSync(new URL(`./oracles/${name}.ts`, import.meta.url), "utf8").includes('from "./authority-graph"')).toBe(false);
    }
  });
  it("rejects every unknown mode and missing mandatory archive mirror", () => {
    for (const mode of [{kind:"archive"}, {kind:"archive-v4"}, {kind:"archive-v3"}, {kind:"live-future"}]) {
      expect(() => new AuthorityGraph(mode as never, {} as never, new Map(), new Map(), new Map())).toThrow();
    }
  });
  it("keeps null-reference acceptance specific to archive optional fields", () => {
    for (const mode of ["live","recovery"] as const)
      expect(() => new AuthorityReferences(mode,new Map()).require(null,"operation")).toThrow();
    for (const mode of ["archive-v1","archive-v2","archive-v3"] as const)
      expect(() => new AuthorityReferences(mode,new Map()).require(null,"operation")).not.toThrow();
  });
  for (const shape of ["empty", "reserved", "abandoned", "takeover", "pending-restore", "pending-create", "rename-receipt"] as const)
    it(`independent live/recovery valid shape: ${shape}`, async () => {
      const oldDb = shape === "empty" ? await openMemoryDriver() : await copyCatalog(source.driver);
      if (shape === "empty") { oldDb.exec("ATTACH DATABASE ':memory:' AS catalog"); OriginalCatalog.initializeFresh(oldDb); }
      let newDb: DbDriver | undefined;
      try {
        const catalog = OriginalCatalog.openExisting(oldDb), expectedTarget = shape === "empty" ? undefined : catalog.selectedTargetStorage().target;
        const id = (p: string, c: string) => `${p}_${c.repeat(26)}`;
        const nowMs = Date.parse("2026-09-05T20:01:30.000Z");
        if (shape === "reserved" || shape === "abandoned" || shape === "takeover") {
          const reservation = catalog.reserveSelectedProtectionRevision({ expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
            expectedTarget: expectedTarget!, operationId: id("op", "q"), requestSha256: `sha256:${"c".repeat(64)}`, fence: source.fence, nowMs });
          if (shape === "abandoned") catalog.abandonSelectedProtectionRevision({ expectedCatalogGeneration: reservation.reservedCatalogGeneration,
            expectedTarget: expectedTarget!, operationId: reservation.operationId, requestSha256: reservation.requestSha256,
            fence: source.fence, nowMs: nowMs + 1 });
          if (shape === "takeover") { const before = catalog.snapshot(); catalog.recoverExpiredSelectedReservation({
            expectedAuthorityIncarnationId: before.authorityIncarnationId, expectedCatalogGeneration: before.catalogGeneration,
            expectedWriteEpoch: before.writeEpoch, operationId: reservation.operationId, releaseId: id("rel", "z"),
            nowMs: Date.parse("2026-09-05T20:03:00.000Z"), ttlMs: 60_000 }); }
        } else if (shape === "pending-restore") catalog.beginRestoreJob({
          jobId:id("job","j"), appInstanceId:id("app","k"), generationId:id("gen","l"), namespaceId:id("ns","m"), operationId:id("op","n"),
          sourceArchiveSha256:`sha256:${"a".repeat(64)}`, sourceProvenanceId:id("restoreval","p"),
          expectedCatalogGeneration:catalog.snapshot().catalogGeneration, expectedSourceTarget:expectedTarget!, fence:source.fence, nowMs });
        else if (shape === "pending-create") catalog.declareAppGeneration({kind:"create", requestId:id("req","n"),
          expectedCatalogGeneration:catalog.snapshot().catalogGeneration, expectedTarget:expectedTarget!,
          target:{ appInstanceId:id("app","g"),generationId:id("gen","h"),namespaceId:id("ns","i"),storageKey:id("ns","i"),
            userFile:`/${id("ns","i")}-user.db`,systemFile:`/${id("ns","i")}-system.db`,storageKind:"generation",displayName:"Inventory",shellId:"inventory" },
          jobId:id("job","j"),operationId:id("op","k"),requestSha256:`sha256:${"d".repeat(64)}`,fence:source.fence,nowMs });
        else if (shape === "rename-receipt") {
          const after=catalog.updateSelectedAppMetadata({expectedCatalogGeneration:catalog.snapshot().catalogGeneration,
            displayName:"Reviewed name",shellId:"tracker",operationId:id("op","q"),fence:source.fence,nowMs});
          catalog.recordAppLifecycleReceipt({kind:"rename",requestId:id("req","q"),requestSha256:`sha256:${"a".repeat(64)}`,
            jobId:id("job","q"),operationId:id("op","q"),requestedAppInstanceId:expectedTarget!.appInstanceId,
            expectedCatalogGeneration:after.catalogGeneration,completedAt:new Date(nowMs).toISOString()});
        }
        newDb=await copyCatalog(oldDb);
        for (const recovery of [false,true]) {
          const original=await outcome(()=> (recovery ? OriginalCatalog.openForRestoreRecovery(oldDb):OriginalCatalog.openExisting(oldDb)).snapshot());
          expect(await outcome(()=> (recovery ? DeviceCatalog.openForRestoreRecovery(newDb!):DeviceCatalog.openExisting(newDb!)).snapshot())).toEqual(original);
          expect(original.ok).toBe(shape!=="pending-restore" || recovery);
        }
        if (shape==="pending-restore" || shape==="pending-create") {
          for(const db of [oldDb,newDb]) db.exec("UPDATE catalog.pending_jobs SET kind='unknown_job'");
          expect(await outcome(()=>DeviceCatalog.openForRestoreRecovery(newDb!).snapshot())).toEqual(await outcome(()=>OriginalCatalog.openForRestoreRecovery(oldDb).snapshot()));
          expect((await outcome(()=>DeviceCatalog.openForRestoreRecovery(newDb!).snapshot())).ok).toBe(false);
        }
      } finally { oldDb.close(); newDb?.close(); }
    });
  const liveCases = [
    ["valid committed multi-app", ""],
    ["missing identity", "DELETE FROM catalog.id_registry WHERE id_kind='namespace'"],
    ["unknown identity discriminator", "UPDATE catalog.id_registry SET id_kind='future' WHERE id_kind='app'"],
    ["orphan identity", "INSERT INTO catalog.id_registry VALUES ('op_zzzzzzzzzzzzzzzzzzzzzzzzzz','operation','2026-09-05T20:00:00.000Z')"],
    ["missing generation", "DELETE FROM catalog.generations WHERE storage_key='unrelated'"],
    ["genesis digest mismatch", "UPDATE catalog.app_entries SET journal_genesis_state_sha256='sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'"],
    ["active lineage mismatch", "UPDATE catalog.app_entries SET current_lineage_epoch='9',lineage_epoch_high_water='9'"],
    ["missing revision", "DELETE FROM catalog.revision_reservations"],
    ["stale reservation epoch", "UPDATE catalog.revision_reservations SET write_epoch='2'"],
    ["stale finalizer epoch", "UPDATE catalog.revision_reservations SET finalized_write_epoch='2'"],
    ["wrong finalizer release", "UPDATE catalog.revision_reservations SET finalized_release_id='rel_zzzzzzzzzzzzzzzzzzzzzzzzzz'"],
    ["reservation before lease", "UPDATE catalog.revision_reservations SET reserved_at='2026-09-05T20:00:01.000Z'"],
    ["finalization beyond lease", "UPDATE catalog.revision_reservations SET finalized_at='2026-09-05T21:00:00.000Z'"],
    ["publication digest mismatch", "UPDATE catalog.revision_reservations SET state_sha256='sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'"],
    ["missing generation event", "DELETE FROM catalog.catalog_generation_events WHERE event_kind='revision_reserved'"],
    ["stale event epoch", "UPDATE catalog.catalog_generation_events SET write_epoch='2' WHERE event_kind='revision_committed'"],
    ["wrong publication event time", "UPDATE catalog.catalog_generation_events SET at='2026-09-05T20:01:21.000Z' WHERE event_kind='revision_committed'"],
    ["selection mismatch", "UPDATE catalog.catalog_root SET selected_app_instance_id='app_22222222222222222222222222'"],
    ["metadata mismatch", "UPDATE catalog.app_entries SET display_name='Changed'"],
    ["selected tombstone", "UPDATE catalog.app_entries SET tombstoned=1 WHERE app_instance_id='app_aaaaaaaaaaaaaaaaaaaaaaaaaa'"],
    ["retained unselected tombstone", "UPDATE catalog.app_entries SET tombstoned=1 WHERE app_instance_id='app_22222222222222222222222222'"],
    ["physical schema extra object", "CREATE VIEW catalog.unexpected AS SELECT 1"],
  ] as const;
  for (const [name, sql] of liveCases) it(`live: ${name}`, async () => {
    const oldDb = await copyCatalog(source.driver), newDb = await copyCatalog(source.driver);
    try {
      // Corruption must reach validation, not be a rejected SQL write masquerading as a test.
      for (const db of [oldDb, newDb]) { db.exec("PRAGMA ignore_check_constraints=ON"); if (sql) db.exec(sql); }
      const oldResult = await outcome(() => OriginalCatalog.openExisting(oldDb).snapshot());
      const newResult = await outcome(() => DeviceCatalog.openExisting(newDb).snapshot());
      expect(newResult).toEqual(oldResult);
      expect(oldResult.ok).toBe(name === "valid committed multi-app" || name === "retained unselected tombstone");
    } finally { oldDb.close(); newDb.close(); }
  });
  const corruptions: [string, (e: any) => void][] = [
    ["valid", () => {}],
    ["entry order", e => e.catalogAuthority.entries.reverse()],
    ["duplicate entry", e => e.catalogAuthority.entries.push(e.catalogAuthority.entries[0])],
    ["missing generation", e => e.catalogAuthority.generations.pop()],
    ["extra generation", e => e.catalogAuthority.generations.push(e.catalogAuthority.generations[0])],
    ["unknown registry kind", e => e.catalogAuthority.idRegistry[0].idKind = "future"],
    ["missing registry", e => e.catalogAuthority.idRegistry.pop()],
    ["registry order", e => e.catalogAuthority.idRegistry.reverse()],
    ["extra registry", e => e.catalogAuthority.idRegistry.push({idValue:"op_zzzzzzzzzzzzzzzzzzzzzzzzzz",idKind:"operation",retainedAt:headerTime})],
    ["genesis binding", e => e.catalogAuthority.entries[0].journalGenesisLineageEpoch = "9"],
    ["reservation authority", e => e.catalogAuthority.revisionReservations[0].authorityIncarnationId = "auth_zzzzzzzzzzzzzzzzzzzzzzzzzz"],
    ["reservation lease", e => e.catalogAuthority.revisionReservations[0].leaseId = "lease_zzzzzzzzzzzzzzzzzzzzzzzzzz"],
    ["finalizer lease", e => e.catalogAuthority.revisionReservations[0].finalizedLeaseId = "lease_zzzzzzzzzzzzzzzzzzzzzzzzzz"],
    ["finalizer time", e => e.catalogAuthority.revisionReservations[0].finalizedAt = "2026-09-05T21:00:00.000Z"],
    ["request mirror", e => e.targetAuthority.requestReceipts[0].receipt.requestSha256 = `sha256:${"a".repeat(64)}`],
    ["target mirror", e => e.targetAuthority.revisions[0].operationId = "op_zzzzzzzzzzzzzzzzzzzzzzzzzz"],
    ["unknown event", e => e.catalogAuthority.generationEvents[0].eventKind = "future"],
    ["event order", e => e.catalogAuthority.generationEvents.reverse()],
    ["duplicate event", e => e.catalogAuthority.generationEvents.push(e.catalogAuthority.generationEvents[0])],
    ["missing event", e => e.catalogAuthority.generationEvents.pop()],
    ["stale epoch", e => e.catalogAuthority.generationEvents.at(-1).writeEpoch = "9"],
    ["lease authority", e => e.catalogAuthority.leases[0].authorityIncarnationId = "auth_zzzzzzzzzzzzzzzzzzzzzzzzzz"],
    ["duplicate lease", e => e.catalogAuthority.leases.push(e.catalogAuthority.leases[0])],
    ["extra member property", e => e.catalogAuthority.extra = true],
    ["multiple corruptions retain error order", e => {e.catalogAuthority.idRegistry.pop(); e.catalogAuthority.entries.reverse();}],
  ];
  const headerTime = "2026-09-05T20:00:00.000Z";
  for (const [name, mutate] of corruptions) it(`authenticated archive: ${name}`, async () => {
    const bytes = seal(rewriteAuthority(archive, mutate));
    const read = async (fn: typeof originalImport) => {
      const imported = await fn(bytes.slice(), () => key);
      try { return { manifest: imported.manifest, authority: imported.authority, invalidPanels: imported.invalidPanels }; }
      finally { imported.store.close(); }
    };
    const oldResult = await outcome(() => read(originalImport));
    expect(await outcome(() => read(importAuthenticatedAuthorityArchive))).toEqual(oldResult);
    expect(oldResult.ok).toBe(name === "valid");
  });
  for (const version of [1, 2, 3] as const) it(`archive compatibility ${version}`, async () => {
    const clean = await authoritativeArchiveSource();
    try {
      const bytes = await exportAuthorityArchiveV5(await clean.store.exportArchive("Field Service"), clean.driver);
      const legacy = seal(rewriteAuthority(bytes, raw => {
        const c = raw.catalogAuthority as any;
        if (version !== 3) { c.schema = version; delete c.retentionHistory; c.schemaObjects = expectedCatalogSchemaObjects(false); }
        if (version === 1) delete c.lifecycleReceipts;
      }));
      for (const fn of [originalImport, importAuthenticatedAuthorityArchive]) {
        const imported = await fn(legacy.slice(), () => key);
        imported.store.close();
      }
    } finally { clean.store.close(); }
  });
  it("wrong key/tamper cannot reach ZIP parsing or fresh-target creation", async () => {
    const invalidZip = seal(new Uint8Array([1, 2, 3]));
    const invalidMac = invalidZip.slice(); invalidMac[invalidMac.length - 1]! ^= 1;
    for (const bytes of [invalidZip, invalidMac]) {
      let creates = 0;
      const open = async () => { creates++; return openMemoryDriver(); };
      const oldResult = await outcome(() => originalImport(bytes.slice(), () => new Uint8Array(32), open));
      expect(await outcome(() => importAuthenticatedAuthorityArchive(bytes.slice(), () => new Uint8Array(32), open))).toEqual(oldResult);
      expect(oldResult.ok).toBe(false); expect(creates).toBe(0);
    }
  });
  it("preserves published/retained backup histories and rejects corruption in independent live/archive copies", async () => {
    const f=await committedAuthorityArchiveSource();
    const id=(p:string,n:number)=>encodeAuthorityIdBytes(p,new Uint8Array(17).fill(n));
    try {
      const target=f.target.evidence(), before=f.catalog.snapshot(), now=Date.parse("2026-09-05T20:03:00.000Z");
      const fence=f.catalog.acquireWriteLease({expectedAuthorityIncarnationId:before.authorityIncarnationId,
        expectedCatalogGeneration:before.catalogGeneration,expectedWriteEpoch:before.writeEpoch,releaseId:id("rel",80),nowMs:now,ttlMs:60_000});
      for(let n=10;n<45;n++) {
        const snapshot=f.catalog.snapshot(), at=new Date(now+n).toISOString();
        f.catalog.publishBackup({request:{schema:1,fence,expected:{schema:1,authorityIncarnationId:snapshot.authorityIncarnationId,
          catalogGeneration:snapshot.catalogGeneration,writeEpoch:snapshot.writeEpoch,selectedAppInstanceId:target.appInstanceId,
          selectedActiveGenerationId:target.activeGenerationId,target},artifact:{schema:1,backupId:id("bkp",n),generationId:id("backupgen",n),
          targetId:id("tgt",70),adapterCertificationId:id("btc",71),evidence:target,fileName:buildAutomaticBackupFileName("Fixture",id("backupgen",n),at),
          createdAt:at,validatedAt:at,shapeHead:0,shapeCurrent:0,archiveFormat:5,byteLength:10,archiveSha256:`sha256:${"a".repeat(64)}`,
          authentication:{schema:1,kind:"cose_mac0_hmac_256_256",authenticationVersion:1,keyId:"b".repeat(32),seriesId:"c".repeat(32),generation:String(n)}}},
          operationId:id("op",n),nowMs:now+n});
      }
      const scope={appInstanceId:target.appInstanceId,targetId:id("tgt",70),adapterCertificationId:id("btc",71)};
      const entry=f.catalog.backupRetentionPlan(scope).entries[0]!;
      f.catalog.acknowledgeBackupRemoval({requestId:entry.requestId,intent:entry.intent,outcome:"absent",fence,nowMs:now+100});
      const oldDb=await copyCatalog(f.driver),newDb=await copyCatalog(f.driver);
      try {
        expect(DeviceCatalog.openExisting(newDb).backupRecords()).toEqual(OriginalCatalog.openExisting(oldDb).backupRecords());
        expect(DeviceCatalog.openExisting(newDb).backupRetentionHistory()).toEqual(OriginalCatalog.openExisting(oldDb).backupRetentionHistory());
        for(const db of [oldDb,newDb]) db.exec("UPDATE catalog.backup_retention_root SET revision='2'");
        expect(await outcome(()=>DeviceCatalog.openExisting(newDb).snapshot())).toEqual(await outcome(()=>OriginalCatalog.openExisting(oldDb).snapshot()));
        expect((await outcome(()=>DeviceCatalog.openExisting(newDb).snapshot())).ok).toBe(false);
      } finally { oldDb.close();newDb.close(); }
      const zip=await exportAuthorityArchiveV5(await f.store.exportArchive("Field Service"),f.driver);
      const cases: [string,(e:any)=>void][]=[
        ["valid",()=>{}], ["order",e=>e.catalogAuthority.backupRecords.reverse()],
        ["mirror",e=>e.catalogAuthority.backupRecords[0].validatedAt="2026-09-05T20:03:01.000Z"],
        ["duplicate file",e=>e.catalogAuthority.backupRecords[1].fileName=e.catalogAuthority.backupRecords[0].fileName],
        ["missing acknowledgement",e=>e.catalogAuthority.retentionHistory.events=[]],
        ["wrong retention lease",e=>e.catalogAuthority.retentionHistory.events[0].fence.leaseId=id("lease",99)],
      ];
      for(const [name,mutate] of cases) {
        const bytes=seal(rewriteAuthority(zip,mutate));
        const read=async(fn:typeof originalImport)=>{const result=await fn(bytes.slice(),()=>key);try{return result.authority;}finally{result.store.close();}};
        const expected=await outcome(()=>read(originalImport));
        expect(await outcome(()=>read(importAuthenticatedAuthorityArchive)),name).toEqual(expected);
        expect(expected.ok,name).toBe(name==="valid");
      }
    } finally {f.store.close();}
  },30_000);
});
