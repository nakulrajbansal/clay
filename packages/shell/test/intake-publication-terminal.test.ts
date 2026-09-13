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
  const paused = latch(), release = latch(); let serial = 0; let loseCancel = false;
  const worker = { createMutationContext: () => ({ requestId: `req_${String.fromCharCode(97 + ++serial).repeat(26)}` }),
    intakePresentation: async () => ({ authorityTarget: target, forms, inbox: [], receipts: [], rules: [], deliveryFailures: [], tables: [], trace: {}, legacyCustody: "none" }),
    mutationOutcome: async (_route: string, _payload: unknown, context: { requestId: string }) => results.get(context.requestId) ?? { status: "not_invoked" },
    cancelPresentation: async (_route: string, _payload: unknown, context: { requestId: string }) => {
      cancelled.push(context.requestId);
      if (!results.has(context.requestId)) results.set(context.requestId, { status: "cancelled" });
      if (loseCancel) { loseCancel = false; throw new Error("Owned cancel commit response loss"); }
      return results.get(context.requestId);
    },
    intakeCommand: async (payload: any, context: { requestId: string }) => {
      invoked.push(context.requestId);
      if (pause === "save" && payload.command.route === "intake.saveForm") { paused.release(); await release.promise; }
      if (results.get(context.requestId)?.status === "cancelled") throw new Error("Original invocation terminally cancelled");
      if (JSON.stringify(payload.authorityTarget) !== JSON.stringify(target)) { results.set(context.requestId, { status: "failed" }); throw new Error("Original source changed"); }
      let result;
      if (payload.command.route === "intake.saveForm") { result = payload.command.payload.form; forms.push(result); }
      else { result = { ...forms[0], publishedAt: payload.command.payload.publishedAt }; forms[0] = result; }
      target = { ...target, protectionRevision: String(Number(target.protectionRevision) + 1) };
      results.set(context.requestId, { status: "recorded", current: true, result, target }); return result;
    },
  } as unknown as WorkerClient;
  const relay = new MemoryIntakeRelayStore({ now: () => Date.now() }); const backend = ownedRelayApp({ intakeRelay: relay, now: () => Date.now() });
  let posts = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/intake/forms") { posts++; if (pause === "http") { paused.release(); await release.promise; } }
    return backend.request(path, init);
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
  return { publication, open, proposal, originalId, originalTarget, cacheRows, custody, results, invoked, cancelled, forms, paused, release, relay, backend,
    posts: () => posts, loseCancel: () => { loseCancel = true; }, bump: () => { target = { ...target, protectionRevision: "8" }; } };
}

it("fences a delayed original save across cache loss and never invokes it after terminal acknowledgement", async () => {
  const f = await fixture("save"); const pending = f.publication.resume().then(() => "published", () => "stopped");
  await f.paused.promise; const request = f.publication.pending()!.save!.requestId;
  f.cacheRows.clear(); const reopened = await f.open(); await reopened.terminalize();
  f.release.release(); expect(await pending).toBe("stopped");
  expect(f.results.get(request)?.status).toBe("cancelled"); expect(f.forms).toHaveLength(0); expect(f.posts()).toBe(0);
  expect(f.custody.size).toBe(1); expect((await f.open()).pending()).toBeNull();
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
