import { expect, it } from "vitest";
import { IndexedDbIntakeWorkflows, IntakeWorkflowSlot } from "../src/intake/workflows";
import { OwnedFactory } from "./helpers/owned-idb";
import type { IntakePublicationJobV1 } from "@clay/schema/intake-workflow";

const origin = "https://owner.example";
const app = `app_${"a".repeat(26)}`;
function cache() {
  const rows = new Map<string, string>();
  return { rows, getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value); }, removeItem: (key: string) => { rows.delete(key); } };
}
const job: IntakePublicationJobV1 = { schema: 1, formId: `form_${"b".repeat(26)}`,
  source: { appInstanceId: app, activeGenerationId: `gen_${"c".repeat(26)}`, lineageEpoch: "0", protectionRevision: "2", digestSchema: 1, stateSha256: `sha256:${"a".repeat(64)}` },
  configuration: { shellOrigin: origin, relayBaseUrl: "https://relay.example/", publicBaseUrl: origin },
  proposal: { title: "Owned form", description: "", target: { tableId: "tbl_11111111-1111-7111-8111-111111111111", expectedSchemaVersion: 1 },
    fields: [{ fieldId: "fld_22222222-2222-7222-8222-222222222222", label: "Title", type: "text", required: true, maxLength: 100, options: [] }], fileRequests: [], expiresAt: "2030-01-01T00:00:00.000Z" },
  save: null, publish: null, complete: null, relayInvoked: false, relayConfirmed: false };

it("recovers public-only immutable work after complete cache loss and rejects an old tab overwriting terminalization", async () => {
  const factory = new OwnedFactory(); const makeStore = () => new IndexedDbIntakeWorkflows(factory as unknown as IDBFactory);
  const firstCache = cache(); const a = new IntakeWorkflowSlot(makeStore(), firstCache, origin, app, "publication");
  await a.recover(); await a.persist(job);
  firstCache.rows.clear();
  const secondCache = cache(); const b = new IntakeWorkflowSlot(makeStore(), secondCache, origin, app, "publication");
  expect((await b.recover())?.formId).toBe(job.formId);
  const terminal = { ...job, termination: { requestedAt: "2026-09-13T12:00:00.000Z", complete: false } };
  await b.persist(terminal);
  await expect(a.persist(job)).rejects.toThrow(/conflict|changed/);
  expect((await new IntakeWorkflowSlot(makeStore(), cache(), origin, app, "publication").recover())?.termination).not.toBeNull();
  expect([...factory.rows.values()].some(row => /ownerPrivateKey|ownerToken|submitToken/.test(JSON.stringify(row)))).toBe(false);
});

it("retains the durable invocation when presentation acknowledgement fails after commit", async () => {
  const factory = new OwnedFactory(); const store = new IndexedDbIntakeWorkflows(factory as unknown as IDBFactory);
  const broken = cache(); let fail = false; const set = broken.setItem;
  broken.setItem = (key, value) => { if (fail) throw new Error("Owned cache lost"); set(key, value); };
  const a = new IntakeWorkflowSlot(store, broken, origin, app, "publication"); await a.recover(); fail = true;
  await expect(a.persist(job)).rejects.toThrow();
  expect((await new IntakeWorkflowSlot(store, cache(), origin, app, "publication").recover())?.formId).toBe(job.formId);
  expect(factory.opens).toBe(factory.closes);
});

it("does not silently replace an original source or configuration, and refuses premature close", async () => {
  const factory = new OwnedFactory(); const store = new IndexedDbIntakeWorkflows(factory as unknown as IDBFactory);
  const a = new IntakeWorkflowSlot(store, cache(), origin, app, "publication"); await a.recover(); await a.persist(job);
  await expect(a.persist({ ...job, source: { ...job.source, protectionRevision: "3" } })).rejects.toThrow(/immutable|identity/);
  await expect(a.persist({ ...job, configuration: { ...job.configuration, relayBaseUrl: "https://changed.example/" } })).rejects.toThrow(/immutable|identity/);
  await expect(a.finish()).rejects.toThrow(/terminal|complete/);
});

it("quarantines a conflicting cached source instead of silently discarding its retained invocation", async () => {
  const store = new IndexedDbIntakeWorkflows(new OwnedFactory() as unknown as IDBFactory); const cached = cache();
  const a = new IntakeWorkflowSlot(store, cached, origin, app, "publication"); await a.recover(); await a.persist(job);
  const conflicting = JSON.stringify({ ...job, source: { ...job.source, protectionRevision: "9" } });
  cached.setItem(a.cacheKey, conflicting);
  await expect(new IntakeWorkflowSlot(store, cached, origin, app, "publication").recover()).rejects.toThrow(/immutable|conflict/);
  expect(cached.getItem(a.cacheKey) === conflicting).toBe(true);
});

it("does not grant a durable invocation fence to an old cache-only workflow that another old tab may still invoke", async () => {
  const store = new IndexedDbIntakeWorkflows(new OwnedFactory() as unknown as IDBFactory); const cached = cache();
  const slot = new IntakeWorkflowSlot(store, cached, origin, app, "publication"); const raw = JSON.stringify(job);
  cached.setItem(slot.cacheKey, raw);
  await expect(slot.recover()).rejects.toThrow(/legacy|Legacy|unfenced/);
  expect(cached.getItem(slot.cacheKey) === raw).toBe(true); expect(await store.read(slot.key)).toBeNull();
});
