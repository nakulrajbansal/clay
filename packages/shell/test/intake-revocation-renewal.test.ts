import { expect, it } from "vitest";
import { IntakeOwnerClient } from "../src/intake/owner-client";
import { IntakeSession } from "../src/intake/session";
import { prepareIntakeOwnerForm, type IntakeOwnerCustody, type IntakeOwnerVault } from "../src/intake/owner-custody";
import { IndexedDbIntakeWorkflows } from "../src/intake/workflows";
import type { WorkerClient } from "../src/app/worker-client";
import { OwnedFactory } from "./helpers/owned-idb";
import { ownedRelayApp } from "../../backend/test/helpers/owned-relay-app";
import { MemoryIntakeRelayStore } from "../../backend/src/intake-relay";

function latch() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function fixture() {
  const app = `app_${"a".repeat(26)}`, config = { shellOrigin: "https://owner.example", publicBaseUrl: "https://owner.example", relayBaseUrl: "https://relay.example/" };
  let target = { appInstanceId: app, activeGenerationId: `gen_${"b".repeat(26)}`, lineageEpoch: "0", protectionRevision: "1", digestSchema: 1 as const, stateSha256: `sha256:${"c".repeat(64)}` };
  const cacheRows = new Map<string, string>(), custody = new Map<string, IntakeOwnerCustody>();
  const cache = { getItem: (k: string) => cacheRows.get(k) ?? null, setItem: (k: string, v: string) => { cacheRows.set(k, v); }, removeItem: (k: string) => { cacheRows.delete(k); } };
  const vault: IntakeOwnerVault = { read: async key => custody.get(key) ?? null, insert: async row => { if (!custody.has(row.key)) custody.set(row.key, structuredClone(row)); } };
  const factory = new OwnedFactory(), workflows = new IndexedDbIntakeWorkflows(factory as unknown as IDBFactory);
  const draft = await prepareIntakeOwnerForm({ source: target, formId: `form_${"d".repeat(26)}`, ...config, vault,
    title: "Owned renewal", description: "", expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(), target: { tableId: "tbl_11111111-1111-7111-8111-111111111111", expectedSchemaVersion: 1 },
    fields: [{ fieldId: "fld_22222222-2222-7222-8222-222222222222", label: "Title", type: "text", required: true, maxLength: 100, options: [] }], fileRequests: [] });
  let form: import("@clay/schema/intake").LocalIntakeFormV2 = { ...draft, publishedAt: new Date().toISOString() };
  const outcomes = new Map<string, any>(), invoked: string[] = [], cancels: string[] = [];
  const paused = latch(), release = latch(); let serial = 0, first = true, loseCancel = false, losePersist = false, loseReadback = false;
  const worker = { createMutationContext: () => ({ requestId: `req_${String.fromCharCode(97 + ++serial).repeat(26)}` }),
    intakePresentation: async () => ({ authorityTarget: structuredClone(target), forms: [structuredClone(form)], rules: [], inbox: [], receipts: [], deliveryFailures: [], tables: [], trace: {}, legacyCustody: "none" }),
    mutationOutcome: async (_r: string, _p: unknown, c: { requestId: string }) => {
      if (loseReadback) { loseReadback = false; throw new Error("Owned outcome readback lost"); }
      return outcomes.get(c.requestId) ?? { status: "not_invoked" };
    },
    cancelPresentation: async (_r: string, _p: unknown, c: { requestId: string }) => {
      cancels.push(c.requestId); if (!outcomes.has(c.requestId)) outcomes.set(c.requestId, { status: "cancelled" });
      if (loseCancel) { loseCancel = false; throw new Error("Owned cancel acknowledgement lost"); } return outcomes.get(c.requestId);
    },
    intakeCommand: async (payload: any, c: { requestId: string }) => {
      invoked.push(c.requestId);
      if (first) { first = false; paused.release(); await release.promise; }
      if (outcomes.get(c.requestId)?.status === "cancelled") throw new Error("Original invocation cancelled");
      if (JSON.stringify(payload.authorityTarget) !== JSON.stringify(target)) throw new Error("Source changed");
      if (form.revokedAt === null) form = { ...form, revokedAt: payload.command.payload.revokedAt, terminalReason: "revoked" as const };
      target = { ...target, protectionRevision: String(Number(target.protectionRevision) + 1) };
      outcomes.set(c.requestId, { status: "recorded", current: true, result: structuredClone(form), target: structuredClone(target) }); return form;
    },
  } as unknown as WorkerClient;
  const backend = ownedRelayApp({ intakeRelay: new MemoryIntakeRelayStore() }); let terminalCalls = 0;
  const fetcher: typeof fetch = async (url, init) => { terminalCalls++;
    const response = await backend.request(new URL(String(url)).pathname, init);
    if (losePersist) { losePersist = false; factory.failCommit = true; } return response;
  };
  const construct = async (configuration = config) => { const session = new IntakeSession(cache, worker, app); await session.read();
    return new IntakeOwnerClient(session, vault, configuration, fetcher, workflows); };
  const open = async (configuration = config) => { const owner = await construct(configuration); await owner.recover(); return owner; };
  const owner = await open(), originalForm = structuredClone(form);
  const pending = owner.revoke(form).then(() => "done", () => "stopped"); await paused.promise;
  const original = owner.pendingRevocation()!;
  const bump = () => { target = { ...target, protectionRevision: String(Number(target.protectionRevision) + 1) }; };
  return { open, construct, owner, original, originalForm, pending, release, cacheRows, custody, factory, outcomes, invoked, cancels, bump,
    target: () => structuredClone(target), form: () => form, terminalCalls: () => terminalCalls,
    loseCancel: () => { loseCancel = true; }, losePersist: () => { losePersist = true; },
    loseReadback: () => { loseReadback = true; },
    changeGeneration: () => { target = { ...target, activeGenerationId: `gen_${"z".repeat(26)}` }; },
    closeFromUnknownId: () => { form = { ...form, revokedAt: new Date().toISOString(), terminalReason: "revoked" }; bump(); } };
}

it("explicitly renews a stale local revoke only after cancelling the delayed original and verifying exact remote terminal proof", async () => {
  const f = await fixture(); f.bump(); const reviewed = f.target();
  const next = await f.open(); await next.renewRevocation(reviewed);
  const retained = next.pendingRevocation()!;
  expect(retained.intent).toEqual(f.original.intent); expect(retained.renewals).toHaveLength(1);
  expect(retained.renewals?.[0]?.previousRequestId).toBe(f.original.intent.requestId);
  expect(f.form().revokedAt).toBeNull(); // Renewal is a retained reviewed job, not a claimed local revoke.
  f.release.release(); expect(await f.pending).toBe("stopped");
  f.cacheRows.clear(); const reopened = await f.open(); await reopened.revoke();
  expect(f.form().terminalReason).toBe("revoked"); expect(reopened.pendingRevocation()).toBeNull();
  expect(new Set(f.invoked).size).toBe(2); expect(f.custody.size).toBe(1);
});

it.each(["cancel", "readback", "persist"])("keeps all original identities when %s acknowledgement fails during reviewed renewal", async fault => {
  const f = await fixture(); f.bump(); if (fault === "cancel") f.loseCancel(); else if (fault === "readback") f.loseReadback(); else f.losePersist();
  await expect((await f.open()).renewRevocation(f.target())).rejects.toThrow();
  f.factory.failCommit = false; f.cacheRows.clear();
  const reopened = await f.open(); expect(reopened.pendingRevocation()?.intent).toEqual(f.original.intent);
  expect(reopened.pendingRevocation()?.renewals ?? []).toHaveLength(0);
  expect(f.invoked).toEqual([f.original.intent.requestId]);
  await reopened.renewRevocation(f.target()); f.release.release(); expect(await f.pending).toBe("stopped");
  await reopened.revoke(); expect(f.form().terminalReason).toBe("revoked");
});

it.each(["review", "generation", "configuration"])("does not retarget renewal after %s changes", async fault => {
  const f = await fixture(); const reviewed = f.target();
  if (fault === "generation") f.changeGeneration(); else f.bump();
  const owner = await f.open(fault === "configuration" ? { shellOrigin: "https://owner.example", publicBaseUrl: "https://owner.example", relayBaseUrl: "https://different.example/" } : undefined);
  await expect(owner.renewRevocation(reviewed)).rejects.toThrow(/source|Source|configuration|relay|review/i);
  expect(f.cancels).toHaveLength(0); expect(f.terminalCalls()).toBe(0); expect(f.custody.size).toBe(1);
  expect(owner.pendingRevocation()?.intent).toEqual(f.original.intent); f.release.release(); expect(await f.pending).toBe("stopped");
});

it("adopts cache-only revocation only for original custody, then explicitly renews the stale original without discarding it", async () => {
  const f = await fixture(); f.factory.rows.clear(); f.bump();
  const legacy = await f.construct(); await expect(legacy.recover()).rejects.toThrow(/unfenced/);
  await legacy.adoptLegacyRevocation(f.target());
  expect(legacy.pendingRevocation()?.intent).toEqual(f.original.intent);
  expect(f.form().revokedAt).toBeNull(); expect(f.invoked).toHaveLength(1);
  await legacy.renewRevocation(f.target()); f.release.release(); expect(await f.pending).toBe("stopped");
  f.cacheRows.clear(); const reopened = await f.open(); await reopened.revoke();
  const record = [...f.factory.rows.values()].find(row => (row as any).kind === "revocation") as any;
  expect(record.closed).toBe(true); expect(record.legacyOriginal).toEqual(f.original);
  expect(record.job.terminalProof.form.revokedAt).toBe(f.form().revokedAt);
  expect(record.job.terminalProof.relay.terminal).toBe(true);
});

it.each(["claim", "custody", "generation", "review"])("keeps legacy cache-only revocation untouched after %s failure", async fault => {
  const f = await fixture(); f.factory.rows.clear(); const before = [...f.cacheRows]; const reviewed = f.target();
  if (fault === "claim") f.factory.failCommit = true;
  if (fault === "custody") f.custody.clear();
  if (fault === "generation") f.changeGeneration();
  if (fault === "review") f.bump();
  await expect((await f.construct()).adoptLegacyRevocation(reviewed)).rejects.toThrow();
  expect([...f.cacheRows]).toEqual(before); expect(f.factory.rows.size).toBe(0);
  expect(f.terminalCalls()).toBe(0); expect(f.cancels).toHaveLength(0);
  f.factory.failCommit = false; f.release.release(); await f.pending;
});

it("reconciles a permanently closed local form after another unknown revoke wins, without replaying an active local form as terminal", async () => {
  const f = await fixture(); f.factory.rows.clear(); f.closeFromUnknownId(); const closed = structuredClone(f.form());
  const legacy = await f.construct(); await legacy.adoptLegacyRevocation(f.target());
  await legacy.revoke(); f.release.release(); expect(await f.pending).toBe("stopped");
  expect(f.form()).toEqual(closed); expect(legacy.pendingRevocation()).toBeNull();
  expect(f.invoked).toHaveLength(1); expect(f.cancels).toContain(f.original.intent.requestId);
  f.cacheRows.clear(); expect((await f.open()).pendingRevocation()).toBeNull();
});
