import { afterEach, expect, it, vi } from "vitest";
import { IntakePublication } from "../src/intake/publication";
import { IntakeSession } from "../src/intake/session";
import { IndexedDbIntakeWorkflows } from "../src/intake/workflows";
import type { IntakeOwnerCustody, IntakeOwnerVault } from "../src/intake/owner-custody";
import type { WorkerClient } from "../src/app/worker-client";
import { OwnedFactory } from "./helpers/owned-idb";
import { ownedRelayApp } from "../../backend/test/helpers/owned-relay-app";
import { MemoryIntakeRelayStore } from "../../backend/src/intake-relay";

afterEach(() => vi.useRealTimers());
function latch() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function fixture(pause: "save" | "http" | "none" = "none") {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-13T12:00:00.000Z"));
  const origin = "https://owner.example", relayBaseUrl = "https://relay.example/";
  const app = `app_${"a".repeat(26)}`;
  let target = { appInstanceId: app, activeGenerationId: `gen_${"b".repeat(26)}`, lineageEpoch: "0", protectionRevision: "1", digestSchema: 1 as const, stateSha256: `sha256:${"c".repeat(64)}` };
  const originalTarget = structuredClone(target); const cacheRows = new Map<string, string>();
  const cache = { getItem: (key: string) => cacheRows.get(key) ?? null, setItem: (key: string, value: string) => { cacheRows.set(key, value); }, removeItem: (key: string) => { cacheRows.delete(key); } };
  const factory = new OwnedFactory(), workflows = new IndexedDbIntakeWorkflows(factory as unknown as IDBFactory);
  const custody = new Map<string, IntakeOwnerCustody>(); const vault: IntakeOwnerVault = { read: async key => custody.get(key) ?? null, insert: async row => { if (!custody.has(row.key)) custody.set(row.key, structuredClone(row)); } };
  const results = new Map<string, any>(); const forms: any[] = []; const invoked: string[] = [], cancelled: string[] = [];
  const closed = new Set<string>();
  const paused = latch(), release = latch(), closurePaused = latch(), closureRelease = latch();
  let serial = 0, loseCancel = false, loseClosure = false, holdClosure = false, heldClosure = false, loseReadback = false, loseTerminal = false, failRenewCommit = false;
  const worker = { createMutationContext: () => ({ requestId: `req_${String.fromCharCode(97 + ++serial).repeat(26)}` }),
    intakePresentation: async () => ({ authorityTarget: target, forms, inbox: [], receipts: [], rules: [], deliveryFailures: [], tables: [], trace: {}, legacyCustody: "none" }),
    mutationOutcome: async (_route: string, _payload: unknown, context: { requestId: string }) => {
      if (loseReadback) { loseReadback = false; throw new Error("Owned cancellation readback lost"); }
      return results.get(context.requestId) ?? { status: "not_invoked" };
    },
    cancelPresentation: async (_route: string, _payload: unknown, context: { requestId: string }) => {
      cancelled.push(context.requestId);
      if (!results.has(context.requestId)) results.set(context.requestId, { status: "cancelled" });
      if (loseCancel) { loseCancel = false; throw new Error("Owned cancel commit response loss"); }
      return results.get(context.requestId);
    },
    intakeCommand: async (payload: any, context: { requestId: string }) => {
      invoked.push(context.requestId);
      if (pause === "save" && payload.command.route === "intake.saveForm") { paused.release(); await release.promise; }
      if (holdClosure && !heldClosure && payload.command.route === "intake.closePublication") { heldClosure = true; closurePaused.release(); await closureRelease.promise; }
      if (results.get(context.requestId)?.status === "cancelled") throw new Error("Original invocation terminally cancelled");
      if (JSON.stringify(payload.authorityTarget) !== JSON.stringify(target)) { results.set(context.requestId, { status: "failed" }); throw new Error("Original source changed"); }
      let result;
      if (payload.command.route === "intake.closePublication") {
        closed.add(payload.command.payload.form.publicForm.formId);
        result = { schema: 1, form: payload.command.payload.form, terminal: true, closedAt: new Date().toISOString() };
      }
      else if (closed.has(payload.command.payload.form?.publicForm.formId ?? payload.command.payload.formId)) throw new Error("Publication identity terminally closed");
      else if (payload.command.route === "intake.saveForm") { result = payload.command.payload.form; forms.push(result); }
      else { result = { ...forms[0], publishedAt: payload.command.payload.publishedAt }; forms[0] = result; }
      target = { ...target, protectionRevision: String(Number(target.protectionRevision) + 1) };
      results.set(context.requestId, { status: "recorded", current: true, result, target });
      if (loseClosure && payload.command.route === "intake.closePublication") { loseClosure = false; throw new Error("Owned closure response loss"); }
      return result;
    },
  } as unknown as WorkerClient;
  const relay = new MemoryIntakeRelayStore({ now: () => Date.now() }); const backend = ownedRelayApp({ intakeRelay: relay, now: () => Date.now() });
  let posts = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/intake/forms") { posts++; if (pause === "http") { paused.release(); await release.promise; } }
    const response = await backend.request(path, init);
    if (path.endsWith("/terminalize")) {
      if (loseTerminal) { loseTerminal = false; throw new Error("Owned terminal acknowledgement lost"); }
      if (failRenewCommit) { failRenewCommit = false; factory.failCommit = true; }
    }
    return response;
  };
  const open = async (relayUrl = relayBaseUrl) => {
    const session = new IntakeSession(cache, worker, app); await session.read();
    const publication = new IntakePublication(session, vault, { shellOrigin: origin, publicBaseUrl: origin, relayBaseUrl: relayUrl }, fetcher, workflows);
    await publication.recover(); return publication;
  };
  const publication = await open();
  const proposal = { title: "Owned retained request", description: "", expiresAt: "2026-09-20T12:00:00.000Z", target: { tableId: "tbl_11111111-1111-7111-8111-111111111111", expectedSchemaVersion: 1 },
    fields: [{ fieldId: "fld_22222222-2222-7222-8222-222222222222", label: "Title", type: "text" as const, required: true, maxLength: 100, options: [] }], fileRequests: [] };
  await publication.begin(proposal); const originalId = publication.pending()!.formId;
  return { publication, open, proposal, originalId, originalTarget, cacheRows, custody, results, invoked, cancelled, forms, paused, release, relay, backend, worker, workflows, factory, closed,
    posts: () => posts, loseCancel: () => { loseCancel = true; }, loseClosure: () => { loseClosure = true; }, bump: () => { target = { ...target, protectionRevision: String(Number(target.protectionRevision) + 1) }; },
    holdClosure: () => { holdClosure = true; }, closurePaused, closureRelease, loseReadback: () => { loseReadback = true; },
    loseTerminal: () => { loseTerminal = true; }, failRenewCommit: () => { failRenewCommit = true; },
    changeGeneration: () => { target = { ...target, activeGenerationId: `gen_${"z".repeat(26)}` }; } };
}

async function staleClosure() {
  const f = await fixture("http");
  const publish = f.publication.resume().then(() => "published", () => "stopped"); await f.paused.promise;
  f.factory.rows.clear(); f.holdClosure();
  const close = f.publication.terminalizeLegacy().then(() => "closed", () => "stopped"); await f.closurePaused.promise;
  const original = f.publication.pending()!.termination!.authorityClosure!; f.bump();
  return { ...f, publish, close, original, target: async () => structuredClone((await f.worker.intakePresentation()).authorityTarget) };
}

it("renews only an explicitly reviewed stale closure after cancelling its delayed original and retaining the exact relay proof", async () => {
  const f = await staleClosure(), next = await f.open();
  await next.renewClosure(await f.target());
  const job = next.pending()!, renewal = job.termination!.renewals![0]!;
  expect(job.termination!.authorityClosure).toEqual(f.original); expect(renewal.previousRequestId).toBe(f.original.requestId);
  expect(renewal.terminalStatus).toBe("cancelled"); expect(renewal.relay.terminal).toBe(true); expect(f.closed.size).toBe(0);
  f.closureRelease.release(); expect(await f.close).toBe("stopped");
  f.cacheRows.clear(); await (await f.open()).terminalize();
  f.release.release(); expect(await f.publish).toBe("stopped");
  const record = [...f.factory.rows.values()][0] as any;
  expect(record.closed).toBe(true); expect(record.job.termination.renewals).toHaveLength(1);
  expect(record.job.termination.closureReceipt.requestId).toBe(renewal.intent.requestId);
  expect(record.job.termination.relayTerminal).toEqual(renewal.relay); expect(f.custody.size).toBe(1);
  expect((await f.open()).pending()).toBeNull();
});

it("rejects a physical adoption record which discarded the cache-only original's already-retained closure ID", async () => {
  const f = await staleClosure();
  // Model a syntactically valid old-client adoption envelope, not secret data.
  // Both jobs parse independently; their original closure identity must also be
  // cross-validated when the ledger is read after a full cache teardown.
  const [key, row] = [...f.factory.rows.entries()][0]! as [string, any];
  const original = structuredClone(row.job);
  const replaced = { ...row, legacyOriginal: original, job: { ...row.job, termination: { ...row.job.termination,
    authorityClosure: { ...f.original, requestId: `req_${"z".repeat(26)}` } } } };
  f.factory.rows.set(key, replaced); f.cacheRows.clear();
  // Reduce to a boolean before asserting: never dump a custody-owning session.
  expect(await f.open().then(() => false, error => /readback is invalid/.test(error.message))).toBe(true);
  expect(JSON.stringify(f.factory.rows.get(key)) === JSON.stringify(replaced)).toBe(true);
  f.closureRelease.release(); await f.close; f.release.release(); await f.publish;
});

it.each(["cancel", "readback", "relay", "persist"])("keeps the original closure after %s loss and resumes the same retained chain on reload", async fault => {
  const f = await staleClosure(), next = await f.open();
  if (fault === "cancel") f.loseCancel(); else if (fault === "readback") f.loseReadback();
  else if (fault === "relay") f.loseTerminal(); else f.failRenewCommit();
  await expect(next.renewClosure(await f.target())).rejects.toThrow();
  f.cacheRows.clear(); const recovered = await f.open();
  expect(recovered.pending()?.termination?.authorityClosure).toEqual(f.original);
  expect(recovered.pending()?.termination?.renewals ?? []).toHaveLength(0);
  await recovered.renewClosure(await f.target());
  f.closureRelease.release(); expect(await f.close).toBe("stopped"); await recovered.terminalize();
  f.release.release(); expect(await f.publish).toBe("stopped"); expect(f.closed.size).toBe(1);
});

it.each(["review", "generation", "configuration"])("does not renew a closure after the reviewed %s changes", async fault => {
  const f = await staleClosure(), target = await f.target(), before = f.cancelled.length;
  if (fault === "review") f.bump(); else if (fault === "generation") f.changeGeneration();
  await expect((async () => (await f.open(fault === "configuration" ? "https://changed.example/" : undefined)).renewClosure(target))()).rejects.toThrow();
  expect(f.cancelled).toHaveLength(before); expect(f.closed.size).toBe(0);
  f.closureRelease.release(); await f.close; f.release.release(); await f.publish;
});

it("bounds closure renewal without dropping any earlier identities or retrying a committed closure under a new ID", async () => {
  const f = await staleClosure(), next = await f.open();
  for (let index = 0; index < 8; index++) { await next.renewClosure(await f.target()); f.bump(); }
  expect(next.pending()?.termination?.renewals).toHaveLength(8);
  const before = JSON.stringify(next.pending());
  await expect(next.renewClosure(await f.target())).rejects.toThrow(/bound|limit|renew/i);
  expect(JSON.stringify(next.pending())).toBe(before);
  f.closureRelease.release(); await f.close; f.release.release(); await f.publish;
});

it("recovers the renewed ID after ledger commit succeeds but presentation persistence is lost", async () => {
  const f = await staleClosure(), next = await f.open(); const cache = next.session.cache, set = cache.setItem;
  let lost = false;
  cache.setItem = (key, value) => { if (!lost && JSON.parse(value).termination?.renewals?.length === 1) { lost = true; throw new Error("Owned presentation loss after commit"); } set(key, value); };
  await expect(next.renewClosure(await f.target())).rejects.toThrow(/presentation/);
  const committed = ([...f.factory.rows.values()][0] as any).job.termination.renewals[0].intent;
  f.cacheRows.clear(); const reopened = await f.open(); expect(reopened.pending()?.termination?.renewals?.[0]?.intent).toEqual(committed);
  f.closureRelease.release(); await f.close; await reopened.terminalize(); f.release.release(); await f.publish;
  expect(f.invoked.filter(id => id === committed.requestId)).toHaveLength(1);
});

it("refuses renewal when the original closure committed but its response was lost", async () => {
  const f = await fixture("http"), publish = f.publication.resume().then(() => "published", () => "stopped"); await f.paused.promise;
  f.factory.rows.clear(); f.loseClosure(); await expect(f.publication.terminalizeLegacy()).rejects.toThrow(/response loss/);
  const original = f.publication.pending()!.termination!.authorityClosure!; f.cacheRows.clear(); const reopened = await f.open();
  await expect(reopened.renewClosure((await f.worker.intakePresentation()).authorityTarget)).rejects.toThrow(/existing receipt/);
  expect(reopened.pending()?.termination?.authorityClosure).toEqual(original); expect(reopened.pending()?.termination?.renewals).toBeUndefined();
  await reopened.terminalize(); f.release.release(); await publish;
  expect(f.invoked.filter(id => id === original.requestId)).toHaveLength(1);
});

it("keeps an already-retained legacy closure invocation when only its ledger is lost", async () => {
  const f = await staleClosure(); f.factory.rows.clear();
  await expect(f.publication.terminalizeLegacy()).rejects.toThrow(/source/);
  expect(f.publication.pending()?.termination?.authorityClosure).toEqual(f.original);
  expect(f.closed.size).toBe(0);
  const reopened = await f.open(); await reopened.renewClosure(await f.target());
  f.closureRelease.release(); await f.close; await reopened.terminalize(); f.release.release(); await f.publish;
});

it("fences a delayed original save across cache loss and never invokes it after terminal acknowledgement", async () => {
  const f = await fixture("save"); const pending = f.publication.resume().then(() => "published", () => "stopped");
  await f.paused.promise; const request = f.publication.pending()!.save!.requestId;
  f.cacheRows.clear(); const reopened = await f.open(); await reopened.terminalize();
  f.release.release(); expect(await pending).toBe("stopped");
  expect(f.results.get(request)?.status).toBe("cancelled"); expect(f.forms).toHaveLength(0); expect(f.posts()).toBe(0);
  expect(f.custody.size).toBe(1); expect((await f.open()).pending()).toBeNull();
});

it("claims cache-only legacy work for closure only, then excludes delayed unknown old-client IDs at the authority", async () => {
  const f = await fixture("http"); const pending = f.publication.resume().then(() => "published", () => "stopped");
  await f.paused.promise; const original = f.publication.pending()!;
  f.factory.rows.clear(); // Synthetic pre-ledger client: only its public cache and private custody exist.
  await expect(f.open()).rejects.toThrow(/unfenced/);
  await f.publication.terminalizeLegacy();
  expect(f.closed.has(original.formId)).toBe(true);
  const target = (await f.worker.intakePresentation()).authorityTarget;
  await expect(f.worker.intakeCommand({ authorityTarget: target, command: { route: "intake.markPublished",
    payload: { formId: original.formId, publishedAt: new Date().toISOString() } } }, f.worker.createMutationContext())).rejects.toThrow(/closed/);
  f.release.release(); expect(await pending).toBe("stopped");
  expect(f.forms).toHaveLength(1); expect(f.forms[0].publishedAt).toBeNull(); expect(f.custody.size).toBe(1);
  const persisted = await f.workflows.read(JSON.stringify([1, original.configuration.shellOrigin, original.source.appInstanceId, "publication"]));
  expect(persisted?.closed).toBe(true); expect(persisted?.legacyOriginal).toEqual(original);
  f.cacheRows.clear(); expect((await f.open()).pending()).toBeNull();
});

it.each(["claim", "cancel", "authority"])("retains cache-only originals across %s commit/readback loss and full cache teardown", async fault => {
  const f = await fixture("http"); const pending = f.publication.resume().then(() => "published", () => "stopped");
  await f.paused.promise; const original = f.publication.pending()!; f.factory.rows.clear();
  if (fault === "claim") f.factory.failCommit = true;
  else if (fault === "cancel") f.loseCancel(); else f.loseClosure();
  await expect(f.publication.terminalizeLegacy()).rejects.toThrow(); f.factory.failCommit = false;
  if (fault === "claim") {
    expect(f.publication.pending()).toEqual(original); expect(f.closed.size).toBe(0);
    await f.publication.terminalizeLegacy();
  } else {
    f.cacheRows.clear(); const reopened = await f.open();
    expect(reopened.pending()?.formId).toBe(original.formId);
    await expect(reopened.resume()).rejects.toThrow(/closing/); await reopened.terminalize();
  }
  f.release.release(); expect(await pending).toBe("stopped"); expect(f.custody.size).toBe(1); expect(f.forms[0].publishedAt).toBeNull();
  expect((await f.open()).pending()).toBeNull();
});

it.each(["generation", "custody"])("quarantines legacy closure after original %s loss without claiming terminal success", async fault => {
  const f = await fixture("http"); const pending = f.publication.resume().then(() => "published", () => "stopped");
  await f.paused.promise; const original = f.publication.pending()!; f.factory.rows.clear();
  if (fault === "generation") f.changeGeneration(); else f.custody.clear(); // Owned synthetic loss only.
  await expect(f.publication.terminalizeLegacy()).rejects.toThrow(/source|Source|custody/i);
  expect(f.publication.pending()).toEqual(original); expect(f.closed.size).toBe(0); expect(f.factory.rows.size).toBe(0);
  f.bump(); f.release.release(); expect(await pending).toBe("stopped");
});

it.each(["stale", "expired"])("blocks a delayed original HTTP arrival after %s closure, preserving original keys and explicit renewal", async fault => {
  const f = await fixture("http"); const pending = f.publication.resume().then(() => "published", () => "stopped");
  await f.paused.promise; const retained = f.publication.pending()!;
  if (fault === "stale") f.bump(); else vi.setSystemTime(new Date(f.proposal.expiresAt));
  f.cacheRows.clear(); const reopened = await f.open();
  await reopened.terminalize(); await f.relay.cleanupExpired();
  f.release.release(); expect(await pending).toBe("stopped");
  expect(f.forms).toHaveLength(1); expect(f.forms[0].publishedAt).toBeNull(); expect(f.custody.size).toBe(1);
  expect(f.results.get(retained.publish!.requestId)?.status).toBe("cancelled");
  const renewed = await f.open(); expect(renewed.pending()).toBeNull();
  expect(f.posts()).toBe(1); // Recovery never silently republishes against a new source.
  await renewed.begin({ ...f.proposal, expiresAt: "2026-09-25T12:00:00.000Z" });
  expect(renewed.pending()!.formId).not.toBe(f.originalId);
  expect(f.custody.size).toBe(1); // New custody requires the explicit subsequent invocation.
});

it("recovers a lost terminal worker commit without replacing the original request", async () => {
  const f = await fixture("save"); const pending = f.publication.resume().then(() => "published", () => "stopped");
  await f.paused.promise; const request = f.publication.pending()!.save!.requestId; f.loseCancel();
  await expect((await f.open()).terminalize()).rejects.toThrow(/cancel commit/);
  f.cacheRows.clear(); const reopened = await f.open();
  await expect(reopened.resume().then(() => "published")).rejects.toThrow(/closing/);
  await reopened.terminalize(); f.release.release(); expect(await pending).toBe("stopped");
  expect(f.cancelled).toEqual([request, request]); expect(f.invoked).toEqual([request]);
});

it("keeps retained configuration and custody after cache loss; switching configuration grants no replacement authority", async () => {
  const f = await fixture("http"); const pending = f.publication.resume().then(() => "published", () => "stopped");
  await f.paused.promise; f.cacheRows.clear();
  await expect(f.open("https://switched.example/")).rejects.toThrow(/original|Original/);
  expect(f.custody.size).toBe(1); expect(f.posts()).toBe(1);
  const original = await f.open(); await original.terminalize(); f.release.release(); expect(await pending).toBe("stopped");
});
