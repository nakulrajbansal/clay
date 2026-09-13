import { afterEach, expect, it, vi } from "vitest";
import { ClayStore, deriveInverse, type ForwardOpT } from "@clay/kernel";
import { projectPlaintextV1 } from "@clay/kernel/projection";
import { approveShareScopeV1, encryptApprovedShareV1 } from "../src/share/crypto";
import { ShareOwnerSession } from "../src/share/owner-custody";
import { IndexedDbShareOwnerVault } from "../src/share/owner-custody.browser";
import { BrowserShareRelayClient } from "../src/share/relay-client";
import { OwnedFactory } from "./helpers/owned-idb";
import { ownedRelayApp } from "../../backend/test/helpers/owned-relay-app";
import { MemoryShareRelayStore } from "../../backend/src/share-store";

afterEach(() => vi.useRealTimers());
function latch() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function fixture() {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-13T12:00:00.000Z"));
  const store = await ClayStore.openMemory();
  try {
    const ops: ForwardOpT[] = [{ op: "create_table", table: "notes", columns: [{ name: "title", type: "text", required: true }] }];
    store.commit({ intent: "Owned fixture", summary: "Owned fixture", migration: { operations: ops, inverse: deriveInverse(ops, store.registrySnapshot()) } });
    const row = store.insert("notes", { title: "Owned immutable snapshot" }), table = store.validationRegistrySnapshot().get("notes")!;
    const request = { schema: 1 as const, kind: "record" as const, expectedSchemaVersion: store.currentVersion(), tableId: table.semantic!.tableId,
      fieldIds: [table.columns[0]!.semantic!.fieldId], recordId: String(row.id), options: { includeRecordIds: false, redactedFieldIds: [] } };
    const artifact = projectPlaintextV1(store, request), approval = await approveShareScopeV1(request, [], artifact, new Date());
    const encrypted = await encryptApprovedShareV1({ request, artifact, approval, attachments: [], expiresAt: "2026-09-20T12:00:00.000Z" });
    let source = { appInstanceId: `app_${"a".repeat(26)}`, activeGenerationId: `gen_${"b".repeat(26)}`, lineageEpoch: "0", protectionRevision: "1", digestSchema: 1 as const, stateSha256: `sha256:${"c".repeat(64)}` };
    const originalSource = structuredClone(source); const factory = new OwnedFactory();
    const backend = ownedRelayApp({ shares: new MemoryShareRelayStore(), now: () => Date.now() });
    const paused = latch(), release = latch(); let delay = false, loseTerminal = false, posts = 0;
    const relay = new BrowserShareRelayClient("https://relay.example", null, async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/shares") { posts++; if (delay) { paused.release(); await release.promise; } }
      const response = await backend.request(path, init);
      if (path.endsWith("/terminalize") && loseTerminal) { loseTerminal = false; throw new Error("Owned terminal response lost"); }
      return response;
    });
    const vault = () => new IndexedDbShareOwnerVault(factory as unknown as IDBFactory);
    const open = (client = relay) => new ShareOwnerSession(vault(), client, "https://owner.example", "https://owner.example", async () => source);
    const prepared = await open().prepare({ encrypted, source, approval, title: "Owned snapshot" });
    return { id: prepared.request.shareId, encrypted, prepared, originalSource, vault, open, relay, backend, paused, release, factory,
      delay: () => { delay = true; }, loseTerminal: () => { loseTerminal = true; }, posts: () => posts,
      bump: () => { source = { ...source, protectionRevision: "2" }; }, fork: () => { source = { ...source, appInstanceId: `app_${"d".repeat(26)}` }; } };
  } finally { store.close(); }
}

it.each(["stale", "expired"])("closes a %s prepared snapshot through an exact terminal receipt without projecting or replacing it", async state => {
  const f = await fixture();
  if (state === "stale") f.bump(); else vi.setSystemTime(new Date(f.prepared.request.expiresAt));
  await expect(f.open().publish(f.id).then(() => "published")).rejects.toThrow(/source changed|expired/);
  expect(f.posts()).toBe(0);
  expect((await f.open().revoke(f.id)).state).toBe("revoked");
  const retained = (await f.vault().list())[0]!;
  expect(JSON.stringify(retained.request) === JSON.stringify(f.encrypted.request)).toBe(true);
  expect(retained.source).toEqual(f.originalSource);
});

it("prevents delayed create completion after tombstone/readback loss and preserves exact custody through reload", async () => {
  const f = await fixture(); f.delay();
  const original = f.open().publish(f.id).then(() => "published", () => "stopped"); await f.paused.promise;
  f.bump(); f.loseTerminal(); await expect(f.open().revoke(f.id).then(() => "closed")).rejects.toThrow(/uncertain/);
  expect((await f.vault().list())[0]?.state).toBe("revoke_pending");
  f.release.release(); expect(await original).toBe("stopped");
  expect((await f.open().revoke(f.id)).state).toBe("revoked");
  expect((await f.backend.request(`/shares/${f.id}`)).status).toBe(410);
  expect(f.posts()).toBe(1); expect(await f.vault().list()).toHaveLength(1);
  expect(JSON.stringify((await f.vault().list())[0]!.request) === JSON.stringify(f.encrypted.request)).toBe(true);
});

it("cannot use a configuration switch or a fork to acquire the original owner invocation", async () => {
  const f = await fixture(); const changed = new BrowserShareRelayClient("https://changed.example", null, vi.fn());
  await expect(f.open(changed).revoke(f.id).then(() => "closed")).rejects.toThrow(/source or relay changed/);
  f.fork(); expect(await f.open().list()).toHaveLength(0);
  await expect(f.open().revoke(f.id).then(() => "closed")).rejects.toThrow(/source or relay changed/);
  expect((await f.vault().list())[0]?.state).toBe("prepared"); expect(f.posts()).toBe(0);
});
