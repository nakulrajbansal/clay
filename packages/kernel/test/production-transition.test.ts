import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ClayStore } from "../src/store";
import { openMemoryDriver, inheritAutomationPhysicalTransactionCapability, type DbDriver } from "../src/db";
import { createLiveWriteGuard } from "../src/live-write-guard";
import { ProductionMutationCoordinator, armProductionMutationFailureForTest } from "../src/production-mutation-coordinator";
import { ProductionMutationCoordinator as OriginalCoordinator, armProductionMutationFailureForTest as armOriginal } from "./oracles/production-mutation-coordinator";
import { captureCoreMutation } from "../src/production-core-routes";
import { captureCoreMutation as originalCapture } from "./oracles/production-core-routes";
import { DeviceCatalog } from "../src/device-catalog";
import { TargetAuthorityStore } from "../src/target-authority";
import { StateMerkleIndex } from "../src/state-merkle-index";
import { enumerateCanonicalStateV1 } from "../src/canonical-state";
import { seededStoreWithDriver } from "./helpers";
import { productionDailyPresentation } from "../src/production-daily-projection";
import { ProductionStoreAuthority } from "../src/production-authority";

const at = Date.parse("2026-09-14T12:00:00.000Z");
const id = (prefix: string, char: string) => `${prefix}_${char.repeat(26)}`;
let base: Awaited<ReturnType<typeof seed>>;
async function seed() {
  const { store, driver } = await seededStoreWithDriver();
  store.commit({ intent: "add panels", summary: "Panels", migration: {
    operations: [{ op: "create_table", table: "people", columns: [{ name: "name", type: "text", required: true }] }],
    inverse: [{ op: "drop_table_if_created_by_this", table: "people" }],
  }, panels: [{
    panel_id: "project_table", title: "Projects", placement: { region: "main", order: 0 },
    code: "export default function(clay){}", declared_queries: [], declared_writes: [],
  }] });
  store.renamePanel("project_table", "Reviewed projects");
  store.insert("people", { name: "Dev" }); store.insert("people", { name: "Kim" });
  store.recordSampleRowProvenance([]);
  const canonical = enumerateCanonicalStateV1(driver, store.validationRegistrySnapshot());
  StateMerkleIndex.createSchema(driver);
  StateMerkleIndex.initialize(driver, canonical.leaves.map(leaf => leaf.seed));
  TargetAuthorityStore.createSchema(driver);
  const target = TargetAuthorityStore.initialize(driver, { schema: 1, appInstanceId: id("app", "a"),
    activeGenerationId: id("gen", "b"), lineageEpoch: "0", lineageEpochHighWater: "0",
    protectionRevision: "0", protectionRevisionHighWater: "0", digestSchema: 1 }).evidence();
  driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  const catalog = DeviceCatalog.initializeFresh(driver);
  catalog.seedSelectedTarget({ target, namespaceId: id("ns", "c"), storageKey: "default", displayName: "Projects",
    shellId: "blank", operationId: id("op", "d"), at: new Date(at).toISOString() });
  const before = catalog.snapshot();
  const fence = catalog.acquireWriteLease({ expectedAuthorityIncarnationId: before.authorityIncarnationId,
    expectedCatalogGeneration: before.catalogGeneration, expectedWriteEpoch: before.writeEpoch,
    releaseId: id("rel", "e"), nowMs: at, ttlMs: 60_000 });
  return { driver, store, target, fence, generation: catalog.snapshot().catalogGeneration };
}
const ident = (value: string) => {
  if (!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(value)) throw new Error("unexpected synthetic fixture identifier");
  return `"${value}"`;
};
// Copy ALL three physical schemas, including journals/Merkle/catalog (snapshot()
// deliberately omits authority). Never share a transaction or receipt between runs.
async function copy(source: DbDriver) {
  const driver = await openMemoryDriver();
  driver.exec("PRAGMA foreign_keys=OFF");
  driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  for (const db of ["main", "sys", "catalog"]) {
    for (const row of driver.select(`SELECT name FROM ${db}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`))
      driver.exec(`DROP TABLE ${db}.${ident(String(row.name))}`);
    const objects = source.select(`SELECT type,name,sql FROM ${db}.sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name`);
    for (const object of objects) {
      const type = String(object.type), name = String(object.name);
      if (type !== "table" && type !== "index") throw new Error("unexpected fixture object");
      const sql = String(object.sql).replace(/^(CREATE (?:UNIQUE )?(?:TABLE|INDEX)(?: IF NOT EXISTS)?\s+)("[^"]+"|\w+)/i, `$1${db}.$2`);
      driver.exec(sql);
      if (type === "table") for (const row of source.select(`SELECT * FROM ${db}.${ident(name)}`)) {
        const cols = Object.keys(row);
        driver.exec(`INSERT INTO ${db}.${ident(name)}(${cols.map(ident).join(",")}) VALUES (${cols.map(() => "?").join(",")})`, cols.map(col => row[col]!));
      }
    }
  }
  driver.exec("PRAGMA foreign_keys=ON");
  return driver;
}
function physical(driver: DbDriver) {
  return ["main", "sys", "catalog"].map(db => driver.select(`SELECT type,name,sql FROM ${db}.sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).map(object => ({
    ...object, rows: object.type === "table" ? driver.select(`SELECT * FROM ${db}.${ident(String(object.name))}`).map(row => JSON.stringify(row)).sort() : [],
  })));
}
async function outcome(run: () => unknown) {
  try { return { ok: true, result: await run() }; }
  catch (error) { const e = error as { code?: string; message: string }; return { ok: false, code: e.code, message: e.message }; }
}
async function owned(old: boolean) {
  const raw = await copy(base.driver), session = createLiveWriteGuard(raw);
  const fault = { stage: null as null | "reservation" | "invocation" | "publication" | "readback", hit: 0, terminalWritten: false };
  const trip = () => { const stage = fault.stage; fault.stage = null; fault.hit++; throw new Error(`injected transition ${stage}`); };
  // Observe/fault the guarded connection, never replace its physical exclusion or
  // transaction implementation. All exec still requires the original authority.
  const driver: DbDriver = { ...session.driver,
    exec(sql, params) {
      if ((fault.stage === "reservation" && /UPDATE catalog.app_entries SET revision_high_water/.test(sql))
          || (fault.stage === "invocation" && sql.startsWith("UPDATE sys.production_request_receipts") && params?.[0] === "invoked")
          || (fault.stage === "publication" && /UPDATE catalog.app_entries\s+SET current_protection_revision/.test(sql))) trip();
      session.driver.exec(sql, params);
      if (sql.startsWith("UPDATE catalog.production_request_receipts") && params?.[0] === "committed") fault.terminalWritten = true;
    },
    select(sql, params) {
      if (fault.stage === "readback" && fault.terminalWritten && sql.startsWith("SELECT * FROM sys.production_request_receipts")) trip();
      return session.driver.select(sql, params);
    },
  };
  inheritAutomationPhysicalTransactionCapability(session.driver, driver);
  const store = session.authority.run(() => ClayStore.fromDriver(driver));
  const Ctor = old ? OriginalCoordinator : ProductionMutationCoordinator;
  const coordinator = new Ctor(driver, session.authority, store, base.fence, base.generation, base.target, 60_000, () => Date.now());
  return { ...session, driver, store, coordinator, raw, old, fault };
}
type Owned = Awaited<ReturnType<typeof owned>>;
async function runPair(work: (fixture: Owned) => Promise<unknown>) {
  const old = await owned(true), next = await owned(false);
  // Owned synthetic randomness/time make returned IDs, JSON and DB bytes comparable.
  let counter = 0;
  const random = vi.spyOn(crypto, "getRandomValues").mockImplementation((bytes: any) => {
    for (let i = 0; i < bytes.length; i++) bytes[i] = ((counter++ * 17 + 31) % 251);
    return bytes;
  });
  try {
    counter = 0; const expected = await work(old);
    // SQLite/WASM snapshots resolve in microtasks. Yield the *real* event loop
    // between independent runs so Vitest's RPC acknowledgements can drain.
    await new Promise(resolve => setTimeout(resolve, 0));
    counter = 0; const actual = await work(next);
    expect(actual).toEqual(expected);
    expect(physical(next.driver)).toEqual(physical(old.driver));
    expect(enumerateCanonicalStateV1(next.driver, next.store.validationRegistrySnapshot())).toEqual(enumerateCanonicalStateV1(old.driver, old.store.validationRegistrySnapshot()));
    expect(StateMerkleIndex.open(next.driver).audit()).toEqual(StateMerkleIndex.open(old.driver).audit());
    expect(await next.driver.exportDatabases()).toEqual(await old.driver.exportDatabases());
    return actual;
  } finally { random.mockRestore(); old.store.close(); next.store.close(); await new Promise(resolve => setTimeout(resolve, 0)); }
}
beforeAll(async () => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(at); base = await seed(); });
afterAll(() => { base?.store.close(); vi.useRealTimers(); });

const cases = [
  ["timeline.setCheckpoint", { version: 1, label: "Before changes" }],
  ["timeline.makeLatest", { version: 2 }],
  ["panel.rename", { panelId: "project_table", title: "My projects" }],
  ["panel.remove", { panelId: "project_table" }],
  ["panel.revert", { panelId: "project_table" }],
  ["schema.addColumn", { table: "projects", column: { name: "New notes", type: "text" } }],
  ["schema.addRelationColumn", { table: "projects", column: { name: "Person", type: "relation", relation: { target_table: "people", cardinality: "one" } } }],
  ["schema.renameColumn", { table: "projects", from: "owner", to: "Assigned owner" }],
] as const;
const target = (f: Owned) => TargetAuthorityStore.open(f.driver).evidence();
const fillPayload = { tables: [{ table: "people", rows: [{ name: "Sample one" }, { name: "Sample two" }] }] };
async function fillSamples(f: Owned) {
  return f.coordinator.execute({ requestId: id("req", "j"), route: "samples.fill", payload: fillPayload });
}
const review = (f: Owned) => {
  const p = productionDailyPresentation(f.store, target(f), new Date().toISOString());
  return { authorityTarget: p.authorityTarget, basis: p.snapshot.basis, snapshotDigest: p.snapshot.snapshotDigest };
};
async function dailySetup(f: Owned) {
  await f.coordinator.execute({ requestId: id("req", "a"), route: "daily.timeZone", payload: { timeZone: "America/New_York" } });
  const table = f.store.validationRegistrySnapshot().get("projects")!;
  const field = (name: string) => table.columns.find(col => col.name === name)!.semantic!.fieldId;
  const value = { schema: 1, revision: 1, profiles: [{ schema: 1, enabled: true, profileId: id("dsp", "p"),
    tableId: table.semantic!.tableId, labelFieldId: field("name"), dueFieldId: field("next_milestone"),
    completion: { kind: "enum", fieldId: field("status"), completeValue: "green", terminalValues: ["green"] } }] };
  await f.coordinator.execute({ requestId: id("req", "b"), route: "daily.source", payload: { expectedRevision: 0, value, review: review(f) } });
  return { table, value };
}
describe("independent transition coordinator differential", () => {
  it("samples preserve exact provenance, fill/remove receipts, user rows and reload", async () => {
    const result = await runPair(async f => {
      const filled = await fillSamples(f);
      const fillReplay = await fillSamples(f);
      const provenance = f.store.sampleRowProvenance();
      const removed = await f.coordinator.execute({ requestId: id("req", "k"), route: "samples.remove", payload: {} });
      const Ctor = f.old ? OriginalCoordinator : ProductionMutationCoordinator;
      const replacement = new Ctor(f.driver, f.authority, f.store, base.fence,
        DeviceCatalog.openExisting(f.driver).snapshot().catalogGeneration, target(f), 60_000, () => Date.now());
      const replay = await replacement.execute({ requestId: id("req", "k"), route: "samples.remove", payload: {} });
      const noOp = await replacement.execute({ requestId: id("req", "l"), route: "samples.remove", payload: {} });
      return { filled, fillReplay, provenance, removed, replay, noOp,
        rows: f.store.query({ from: "people" }), retained: f.store.sampleRowProvenance(),
        restorable: f.store.restorableRows("people") };
    }) as any;
    expect(result.filled.result).toEqual({ added: 2, tables: 1 });
    expect(result.fillReplay).toEqual({ ...result.filled, replayed: true });
    expect(result.removed.result).toEqual({ affected: 2, recovery: { kind: "soft_delete", recoverable: 2 } });
    expect(result.replay).toEqual({ ...result.removed, replayed: true });
    expect(result.noOp.changed).toBe(false);
    expect(result.provenance).toHaveLength(2); expect(result.retained).toEqual(result.provenance);
    expect(result.rows.map((row: any) => row.name)).toEqual(["Dev", "Kim"]);
    expect(result.restorable).toHaveLength(2);
  });
  it("samples retain empty producer envelopes and terminal no-op responses", async () => {
    const result = await runPair(async f => {
      const requests = [
        { requestId: id("req", "j"), route: "samples.fill", payload: { tables: [] } },
        { requestId: id("req", "k"), route: "samples.fill", payload: { tables: [{ table: "people", rows: [] }] } },
        { requestId: id("req", "l"), route: "samples.remove", payload: {} },
      ];
      const outcomes = [];
      for (const request of requests) {
        const first = await f.coordinator.execute(request), replay = await f.coordinator.execute(request);
        outcomes.push({ first, replay });
      }
      return { outcomes, ledger: f.store.sampleRowProvenance(), reservations: TargetAuthorityStore.open(f.driver).reservations() };
    }) as any;
    expect(result.outcomes.every((r: any) => !r.first.changed && r.replay.replayed)).toBe(true);
    expect(result.ledger).toEqual([]); expect(result.reservations).toEqual([]);
  });
  for (const route of ["samples.fill", "samples.remove"] as const)
    for (const stage of ["reservation", "invocation", "publication", "readback"] as const)
      it(`${route}: ${stage} failure retains exact provenance and terminal outcome`, async () => {
        const result = await runPair(async f => {
          if (route === "samples.remove") await fillSamples(f);
          const request = { requestId: id("req", "k"), route, payload: route === "samples.fill" ? fillPayload : {} };
          f.fault.terminalWritten = false;
          f.fault.stage = stage;
          const failed = await outcome(() => f.coordinator.execute(request));
          const afterFailure = physical(f.driver);
          return { failed, afterFailure, retry: await outcome(() => f.coordinator.execute(request)), hit: f.fault.hit };
        }) as any;
        expect(result.hit).toBe(1); expect(result.failed.ok).toBe(false);
        expect(result.retry.ok).toBe(stage === "reservation");
      });
  it("samples reject stale receipt/payload collisions without another reservation", async () => {
    const result = await runPair(async f => {
      await fillSamples(f);
      const collision = await outcome(() => f.coordinator.execute({ requestId: id("req", "j"), route: "samples.fill", payload: { tables: [] } }));
      await f.coordinator.execute({ requestId: id("req", "k"), route: "samples.remove", payload: {} });
      return { collision, stale: await outcome(() => fillSamples(f)) };
    }) as any;
    expect(result.collision.ok).toBe(false); expect(result.stale.ok).toBe(false);
  });
  it("samples preserve strict capture errors without invoking accessors", async () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "tables", { enumerable: true, get() { getterCalls++; return []; } });
    const result = await runPair(async f => {
      const outputs = [];
      for (const payload of [accessor, { tables: [], extra: 1 }, { tables: [{ table: "people", rows: [{ name: { nested: true } }] }] },
        { tables: Array(1) }, Object.assign(Object.create({ inherited: true }), { tables: [] })])
        outputs.push(await outcome(() => f.coordinator.execute({ requestId: id("req", "j"), route: "samples.fill", payload })));
      outputs.push(await outcome(() => f.coordinator.execute({ requestId: id("req", "j"), route: "samples.remove", payload: { all: true } })));
      return outputs;
    }) as any[];
    expect(result.every(entry => !entry.ok)).toBe(true); expect(getterCalls).toBe(0);
  });
  it("samples have closed distinct provenance policies and no duplicate coordinator execution", async () => {
    const { productionRouteSpec } = await import("../src/production-core-routes");
    expect(productionRouteSpec("samples.fill")).toMatchObject({ policy: { kind: "canonical-sample-producer-v1" } });
    expect(productionRouteSpec("samples.remove")).toMatchObject({ policy: { kind: "canonical-sample-removal-v1" } });
    const coordinator = readFileSync(new URL("../src/production-mutation-coordinator.ts", import.meta.url), "utf8");
    expect(coordinator).not.toContain('case "samples.fill":'); expect(coordinator).not.toContain('case "samples.remove":');
  });
  for (const [route, payload] of cases) it(`${route}: commit, exact replay, no-op and replacement coordinator`, async () => {
    const result = await runPair(async f => {
      const request = { requestId: id("req", "r"), route, payload };
      const first = await f.coordinator.execute(request);
      const replay = await f.coordinator.execute(request);
      const catalog = DeviceCatalog.openExisting(f.driver);
      const Ctor = f.old ? OriginalCoordinator : ProductionMutationCoordinator;
      const replacement = new Ctor(f.driver, f.authority, f.store, base.fence, catalog.snapshot().catalogGeneration,
        TargetAuthorityStore.open(f.driver).evidence(), 60_000, () => Date.now());
      const reloaded = await replacement.execute(request);
      const repeated = await outcome(() => replacement.execute({ ...request, requestId: id("req", "s") }));
      return { first, replay, reloaded, repeated };
    }) as any;
    expect(result.first.changed).toBe(true);
    expect(result.replay).toEqual({ ...result.first, replayed: true });
    expect(result.reloaded).toEqual(result.replay);
  });
  for (const failure of ["live_mutation", "after_live_mutation", "abandonment_unavailable", "crash_after_invocation", "stale_fence"] as const)
    it(`panel rename: ${failure} preserves receipt, poison, replay and error order`, async () => {
      const result = await runPair(async f => {
        if (f.old) armOriginal(f.coordinator as OriginalCoordinator, failure);
        else armProductionMutationFailureForTest(f.coordinator as ProductionMutationCoordinator, failure);
        const request = { requestId: id("req", "r"), route: "panel.rename", payload: { panelId: "project_table", title: "Changed" } };
        return [await outcome(() => f.coordinator.execute(request)), await outcome(() => f.coordinator.execute(request))];
      }) as any[];
      expect(result[0].ok).toBe(false);
      expect(result[1].ok).toBe(false);
    });
  it("stale historical replay and payload collisions do not reserve", async () => {
    const result = await runPair(async f => {
      const request = { requestId: id("req", "r"), route: "panel.rename", payload: { panelId: "project_table", title: "One" } };
      await f.coordinator.execute(request);
      const collision = await outcome(() => f.coordinator.execute({ ...request, payload: { ...request.payload, title: "Other" } }));
      await f.coordinator.execute({ ...request, requestId: id("req", "s"), payload: { ...request.payload, title: "Two" } });
      return [collision, await outcome(() => f.coordinator.execute(request))];
    }) as any[];
    expect(result.every(value => !value.ok)).toBe(true);
  });
  it("captures before queueing and serializes read barriers between immutable writes", async () => {
    const result = await runPair(async f => {
      const request = { requestId: id("req", "r"), route: "panel.rename", payload: { panelId: "project_table", title: "One" } };
      const first = f.coordinator.execute(request);
      const between = f.coordinator.serializeRead(async () => f.store.livePanels());
      const second = f.coordinator.execute({ ...request, requestId: id("req", "s"), payload: { ...request.payload, title: "Two" } });
      request.payload.title = "Caller changed input after invocation";
      return Promise.all([first, between, second]);
    }) as any[];
    expect(result[0].result[0].title).toBe("One"); expect(result[1][0].title).toBe("One"); expect(result[2].result[0].title).toBe("Two");
  });
  it("poisons queued writes, reads and operational work after an interrupted invocation", async () => {
    const result = await runPair(async f => {
      if (f.old) armOriginal(f.coordinator as OriginalCoordinator, "crash_after_invocation");
      else armProductionMutationFailureForTest(f.coordinator as ProductionMutationCoordinator, "crash_after_invocation");
      const request = { requestId: id("req", "r"), route: "panel.rename", payload: { panelId: "project_table", title: "Interrupted" } };
      return Promise.all([outcome(() => f.coordinator.execute(request)),
        outcome(() => f.coordinator.execute({ ...request, requestId: id("req", "s") })),
        outcome(() => f.coordinator.serializeRead(async () => f.store.livePanels())),
        outcome(() => f.coordinator.executeOperationalMetric({ requestId: id("req", "t"), route: "clearPrivateMetrics", payload: {} })),
      ]);
    }) as any[];
    expect(result.every(value => !value.ok)).toBe(true);
    for (const value of result.slice(1)) expect(value.message).toMatch(/poisoned/);
  });
  it("keeps metrics outside canonical no-op receipts while sharing only queue and read mechanics", async () => {
    const result = await runPair(async f => {
      const before = target(f), catalog = DeviceCatalog.openExisting(f.driver).snapshot();
      const first = await f.coordinator.executeOperationalMetric({ requestId: id("req", "r"), route: "recordPrivateMetric", payload: { event: { type: "trust_surface_opened", surface: "history" } } });
      const cleared = await f.coordinator.executeOperationalMetric({ requestId: id("req", "s"), route: "clearPrivateMetrics", payload: {} });
      const noOp = await f.coordinator.executeOperationalMetric({ requestId: id("req", "t"), route: "clearPrivateMetrics", payload: {} });
      expect(target(f)).toEqual(before); expect(DeviceCatalog.openExisting(f.driver).snapshot()).toEqual(catalog);
      expect(f.driver.select("SELECT * FROM sys.production_request_receipts")).toEqual([]);
      return { first, cleared, noOp };
    }) as any;
    expect(result.first.changed).toBe(true); expect(result.cleared.changed).toBe(true); expect(result.noOp.changed).toBe(false);
  });
  it("Daily timezone and source/navigation CAS preserve no-op receipts and original projections", async () => {
    const result = await runPair(async f => {
      const { table, value } = await dailySetup(f);
      const row = f.store.query({ from: "projects", limit: 1 })[0]!;
      const nav = { schema: 1, revision: 1, recents: [], favorites: [{ tableId: table.semantic!.tableId, rowId: row.id, pinnedAt: new Date().toISOString() }] };
      const request = { requestId: id("req", "c"), route: "daily.navigation", payload: { expectedRevision: 0, value: nav, review: review(f) } };
      const commit = await f.coordinator.execute(request);
      const replay = await f.coordinator.execute(request);
      const stale = await outcome(() => f.coordinator.execute({ ...request, requestId: id("req", "d") }));
      const noOp = await f.coordinator.execute({ requestId: id("req", "e"), route: "daily.source", payload: { expectedRevision: 0, value, review: review(f) } });
      const zone = await f.coordinator.execute({ requestId: id("req", "f"), route: "daily.timeZone", payload: { timeZone: "UTC" } });
      return { commit, replay, stale, noOp, zone };
    }) as any;
    expect(result.commit.changed).toBe(true); expect(result.replay.replayed).toBe(true);
    expect(result.stale.ok).toBe(false); expect(result.noOp.changed).toBe(false); expect(result.zone.changed).toBe(false);
  });
  it("Daily Capture/Undo preserves original receipt, batch and cancellation", async () => {
    const result = await runPair(async f => {
      const request = { requestId: id("req", "r"), route: "daily.capture", payload: { appInstanceId: target(f).appInstanceId,
        table: "projects", tableId: f.store.validationRegistrySnapshot().get("projects")!.semantic!.tableId, row: { name: "Captured" } } };
      const capture = await f.coordinator.execute(request);
      const undo = { requestId: id("req", "s"), route: "daily.undoCapture", payload: { captureRequestId: request.requestId, capturePayload: request.payload,
        batchId: (capture.result as any).id, authorityTarget: target(f) } };
      const undone = await f.coordinator.execute(undo), replay = await f.coordinator.execute(undo);
      const delayed = { ...request, requestId: id("req", "t") };
      return { capture, undone, replay, cancel: await f.coordinator.cancelPresentation(delayed), delayed: await outcome(() => f.coordinator.execute(delayed)) };
    }) as any;
    expect(result.capture.changed).toBe(true); expect(result.undone.changed).toBe(true); expect(result.replay.replayed).toBe(true);
    expect(result.cancel.status).toBe("cancelled"); expect(result.delayed.ok).toBe(false);
  });
  for (const action of ["complete", "snooze", "dismiss"] as const) it(`Inbox ${action} and Undo retain semantic/projection identity`, async () => {
    const result = await runPair(async f => {
      await dailySetup(f);
      const presentation = productionDailyPresentation(f.store, target(f), new Date().toISOString());
      const item = presentation.snapshot.sources.flatMap(source => source.page.items).find(item => item.kind === "due_record" && item.actions.includes(action))!;
      expect(item).toBeDefined();
      const request = { requestId: id("req", "r"), route: "daily.inbox", payload: { action, item, review: review(f),
        ...(action === "snooze" ? { untilLocalDate: "2026-09-15" } : {}) } };
      const commit = await f.coordinator.execute(request), replay = await f.coordinator.execute(request);
      const undo = await f.coordinator.execute({ requestId: id("req", "s"), route: "daily.undoInbox", payload: {
        actionRequestId: request.requestId, actionPayload: request.payload, authorityTarget: target(f) } });
      return { commit, replay, undo };
    }) as any;
    expect(result.commit.changed).toBe(true); expect(result.replay.replayed).toBe(true); expect(result.undo.changed).toBe(true);
  });
  it("relation preview Keep/Undo keeps canonical data and bounded original history", async () => {
    const result = await runPair(async f => {
      const preview = f.store.previewRelationConversion({ sourceTable: "projects", sourceField: "owner", targetTable: "people", displayField: "name" });
      const keep = { requestId: id("req", "r"), route: "schema.convertTextToRelation", payload: { ...preview, authorityTarget: target(f), cardinality: "one" } };
      const commit = await f.coordinator.execute(keep), replay = await f.coordinator.execute(keep);
      const undo = await f.coordinator.execute({ requestId: id("req", "s"), route: "schema.undoRelationConversion", payload: {
        conversionRequestId: keep.requestId, beforeVersion: preview.atVersion, authorityTarget: target(f) } });
      return { commit, replay, undo };
    }) as any;
    expect(result.commit.changed).toBe(true); expect(result.replay.replayed).toBe(true); expect(result.undo.changed).toBe(true);
  });
  it("manual download metadata retains exact source and never claims verified external storage", async () => {
    const result = await runPair(async f => {
      const request = { requestId: id("req", "r"), route: "backup.manualDownload", payload: {
        schema: 2, kind: "manual_download", archiveFormat: 5, fileName: "fixture.clay", byteLength: 512,
        startedAt: new Date().toISOString(), verification: "unverified_external_save",
        authentication: { schema: 1, kind: "cose_mac0_hmac_256_256", authenticationVersion: 1, keyId: "a".repeat(32), seriesId: "b".repeat(32), generation: "1" },
        archiveSha256: `sha256:${"c".repeat(64)}`, evidence: target(f),
      } };
      const first = await f.coordinator.execute(request);
      return { first, replay: await f.coordinator.execute(request) };
    }) as any;
    expect(result.first.changed).toBe(true); expect(result.replay.replayed).toBe(true);
    const module = await import("../src/production-core-routes") as any;
    expect(module.productionRouteSpec("backup.manualDownload")).toMatchObject({ route: "backup.manualDownload" });
  });
  for (const family of ["panel", "daily", "relation"] as const) for (const stage of ["reservation", "invocation", "publication", "readback"] as const)
    it(`${family}: injected ${stage} rolls back exact physical/canonical state and preserves retry outcome`, async () => {
      const result = await runPair(async f => {
        let request: { requestId: string; route: string; payload: unknown };
        if (family === "daily") request = { requestId: id("req", "r"), route: "daily.capture", payload: {
          appInstanceId: target(f).appInstanceId, table: "projects", tableId: f.store.validationRegistrySnapshot().get("projects")!.semantic!.tableId, row: { name: "Fault capture" } } };
        else if (family === "relation") request = { requestId: id("req", "r"), route: "schema.convertTextToRelation", payload: {
          ...f.store.previewRelationConversion({ sourceTable: "projects", sourceField: "owner", targetTable: "people", displayField: "name" }),
          authorityTarget: target(f), cardinality: "one" } };
        else request = { requestId: id("req", "r"), route: "panel.rename", payload: { panelId: "project_table", title: "Fault rename" } };
        f.fault.stage = stage;
        const failed = await outcome(() => f.coordinator.execute(request));
        const afterFailure = physical(f.driver);
        const retry = await outcome(() => f.coordinator.execute(request));
        return { failed, afterFailure, retry, hit: f.fault.hit };
      }) as any;
      expect(result.hit).toBe(1); expect(result.failed.ok).toBe(false);
      expect(result.retry.ok).toBe(stage === "reservation");
    });
  it("worker loss after invocation reopens through strict reservation recovery, without duplicate effects", async () => {
    const result = await runPair(async f => {
      const request = { requestId: id("req", "r"), route: "panel.rename", payload: { panelId: "project_table", title: "Never published" } };
      if (f.old) armOriginal(f.coordinator as OriginalCoordinator, "crash_after_invocation");
      else armProductionMutationFailureForTest(f.coordinator as ProductionMutationCoordinator, "crash_after_invocation");
      const interrupted = await outcome(() => f.coordinator.execute(request));
      const db = await copy(f.driver);
      const reopened = ProductionStoreAuthority.openExisting(db, { inventory: { state: "complete", catalogPresent: true,
        namespaces: [{ storageKey: "default", userFile: "/user.db", systemFile: "/system.db", kind: "legacy" }] },
        storageKey: "default", releaseId: id("rel", "z"), nowMs: at + 61_000, leaseTtlMs: 60_000 });
      try { return { interrupted, state: reopened.inspectAuthority(), bytes: await db.exportDatabases(),
        replay: await outcome(() => reopened.executeMutation(request)), panels: reopened.readStore().livePanels() }; }
      finally { reopened.close(); }
    }) as any;
    expect(result.interrupted.ok).toBe(false); expect(result.replay.ok).toBe(false);
    expect(result.panels[0].title).toBe("Reviewed projects");
  });
  it("requires Daily and relation routes to join the closed policy, without widening the command language", async () => {
    const module = await import("../src/production-core-routes") as any;
    for (const route of ["daily.source", "daily.navigation", "daily.timeZone", "daily.capture", "daily.undoCapture", "daily.inbox", "daily.undoInbox",
      "schema.convertTextToRelation", "schema.undoRelationConversion"])
      expect(module.productionRouteSpec(route)).toMatchObject({ route, policy: { kind: "canonical-shadow-journal-v1", clock: route.startsWith("daily.") ? "trusted-instant" : "none" } });
    const captured = module.captureCoreMutation(id("req", "r"), "panel.remove", { panelId: "project_table" });
    const transition = module.prepareProductionTransition(captured);
    expect(Object.isFrozen(transition.command)).toBe(true);
    expect(() => module.executeProductionTransition(base.store, { ...transition })).toThrow(/not captured/);
    expect(() => module.prepareProductionTransition({ ...captured, payload: { panelId: "injected; SQL" } })).toThrow(/not captured/);
    expect(() => module.productionRouteSpec("panel.rename").prepare(captured)).toThrow(/not captured/);
  });
  it("preserves capture/error order without invoking accessors or admitting descriptor/prototype drift", async () => {
    let calls = 0;
    const accessor = Object.defineProperty({}, "panelId", { enumerable: true, get() { calls++; throw new Error("caller"); } });
    const bad = [accessor, { panelId: "project_table", extra: 1 }, { panelId: "x" },
      Object.create({ panelId: "project_table" }), { panelId: "project_table", [Symbol("x")]: 1 },
      Object.defineProperty({}, "panelId", { value: "project_table" }), []];
    for (const payload of bad) {
      const old = await outcome(() => originalCapture(id("req", "r"), "panel.remove", payload));
      expect(await outcome(() => captureCoreMutation(id("req", "r"), "panel.remove", payload))).toEqual(old);
      expect(old.ok).toBe(false);
    }
    expect(calls).toBe(0);
  });
  it("uses closed immutable route specifications and transitions in the production coordinator", async () => {
    const module = await import("../src/production-core-routes") as any;
    expect(typeof module.productionRouteSpec).toBe("function");
    for (const [route] of cases) {
      const spec = module.productionRouteSpec(route);
      expect(Object.isFrozen(spec)).toBe(true);
      expect(spec).toMatchObject({ route, policy: { kind: "canonical-shadow-journal-v1", clock: "none", native: "guarded-transaction" } });
    }
    for (const route of ["__proto__", "constructor", "sql", "setting.set", "recordPrivateMetric", "app.create", "restoreAsNew"])
      expect(module.productionRouteSpec(route)).toBeNull();
    expect(readFileSync(new URL("../src/production-mutation-coordinator.ts", import.meta.url), "utf8")).toContain("prepareProductionTransition");
  });
});
