import { expect, it, vi } from "vitest";
import { ClayStore, deriveInverse, type ForwardOpT } from "@clay/kernel";
import { projectPlaintextV1 } from "@clay/kernel/projection";
import { approveShareScopeV1, encryptApprovedShareV1 } from "../src/share/crypto";
import { ShareOwnerSession, validateShareOwnerRecord, type ShareOwnerRecord, type ShareOwnerVault } from "../src/share/owner-custody";
import type { ShareRelayClient } from "../src/share/relay-client";
import { IndexedDbShareOwnerVault } from "../src/share/owner-custody.browser";
import { OwnedFactory } from "./helpers/owned-idb";
import * as legacyReceipts from "../src/share/owner-receipts";
import { relayRequestSha256 } from "../src/app/relay-request-identity";

it("has no callerless legacy receipt writer that could replace owner custody", () => {
  for (const name of ["loadOwnerShareReceiptsV1", "saveOwnerShareReceiptV1", "markOwnerShareRevokedV1"])
    expect(typeof Reflect.get(legacyReceipts, name)).toBe("undefined");
});

it("keeps exact owner/source/ciphertext through custody, relay and revocation response loss", async () => {
  const store = await ClayStore.openMemory();
  try {
    const operations: ForwardOpT[] = [{ op: "create_table", table: "notes", columns: [{ name: "title", type: "text", required: true }] }];
    store.commit({ intent: "Owned fixture", summary: "Owned fixture", migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) } });
    const row = store.insert("notes", { title: "Owned reviewed note" }); const table = store.validationRegistrySnapshot().get("notes")!;
    const request = { schema: 1 as const, kind: "record" as const, expectedSchemaVersion: store.currentVersion(), tableId: table.semantic!.tableId,
      fieldIds: [table.columns.find(column => column.name === "title")!.semantic!.fieldId], recordId: String(row.id), options: { includeRecordIds: false, redactedFieldIds: [] } };
    const artifact = projectPlaintextV1(store, request); const approval = await approveShareScopeV1(request, [], artifact, new Date("2026-09-13T12:00:00.000Z"));
    const encrypted = await encryptApprovedShareV1({ request, artifact, approval, attachments: [], expiresAt: "2026-09-20T12:00:00.000Z" });
    const source = { appInstanceId: `app_${"a".repeat(26)}`, activeGenerationId: `gen_${"b".repeat(26)}`, lineageEpoch: "0", protectionRevision: "2", digestSchema: 1 as const, stateSha256: `sha256:${"c".repeat(64)}` };
    let current = source; let record: ShareOwnerRecord | null = null; let lostCommit = true; let lostDelivery = true; let lostRevoke = true;
    const vault: ShareOwnerVault = { list: async () => record ? [structuredClone(record)] : [], compareAndSet: async (before, after) => {
      if (JSON.stringify(record) !== JSON.stringify(before)) {
        if (JSON.stringify(record) === JSON.stringify(after)) return;
        throw new Error("Owned custody conflict");
      }
      record = validateShareOwnerRecord(after);
      if (lostCommit) { lostCommit = false; throw new Error("Owned custody commit response loss"); }
    } };
    const create = vi.fn(async (input: typeof encrypted.request) => {
      expect(record?.state).toBe("invoked"); expect(JSON.stringify(input) === JSON.stringify(encrypted.request)).toBe(true);
      if (lostDelivery) { lostDelivery = false; throw new Error("Owned relay response loss"); }
      return { schema: 1 as const, shareId: input.shareId, expiresAt: input.expiresAt };
    });
    const revoke = vi.fn(async (request: typeof encrypted.request) => {
      expect(record?.state).toBe("revoke_pending");
      if (lostRevoke) { lostRevoke = false; throw new Error("Owned revocation response loss"); }
      return { schema: 1 as const, shareId: request.shareId, expiresAt: request.expiresAt, requestSha256: await relayRequestSha256(request), terminal: true as const };
    });
    const relay: ShareRelayClient = { baseUrl: "https://relay.example.test", create, terminalize: revoke, revoke: vi.fn(), read: vi.fn() };
    const open = () => new ShareOwnerSession(vault, relay, "https://app.example.test", "https://app.example.test", async () => current, () => new Date("2026-09-13T12:00:00.000Z"));
    const session = open();
    await expect(session.prepare({ encrypted, source, title: "Owned snapshot", approval })).rejects.toThrow(/custody/);
    expect(create).not.toHaveBeenCalled(); expect((await open().list())).toHaveLength(1);
    await expect(open().publish(encrypted.request.shareId)).rejects.toThrow(/uncertain/);
    current = { ...source, protectionRevision: "3" }; // Retried delivery is the immutable already-invoked snapshot, never a new projection.
    const published = await open().publish(encrypted.request.shareId); expect(published.state).toBe("published"); expect(create).toHaveBeenCalledTimes(2);
    await expect(open().revoke(encrypted.request.shareId)).rejects.toThrow(/uncertain/);
    const revoked = await open().revoke(encrypted.request.shareId); expect(revoked.state).toBe("revoked"); expect(revoke).toHaveBeenCalledTimes(2);
    // Same production IndexedDB adapter, owned serial transaction/abort fixture.
    const factory = new OwnedFactory(); const adapter = new IndexedDbShareOwnerVault(factory as unknown as IDBFactory);
    const prepared = { ...revoked, state: "prepared" as const, receipt: { ...revoked.receipt, revokedAt: null }, revocationAt: null };
    factory.failCommit = true; await expect(adapter.compareAndSet(null, prepared)).rejects.toThrow(/commit/); expect(await adapter.list()).toHaveLength(0);
    await adapter.compareAndSet(null, prepared); const reopenedVault = new IndexedDbShareOwnerVault(factory as unknown as IDBFactory);
    await reopenedVault.compareAndSet(null, prepared); expect(await reopenedVault.list()).toHaveLength(1);
    const invoked = { ...prepared, state: "invoked" as const }; await reopenedVault.compareAndSet(prepared, invoked);
    await expect(reopenedVault.compareAndSet(prepared, { ...prepared, state: "revoke_pending", revocationAt: "2026-09-13T12:00:00.000Z" })).rejects.toThrow(/conflict/);
    expect((await reopenedVault.list())[0]?.state).toBe("invoked"); expect(factory.closes).toBe(factory.opens);
    current = { ...source, appInstanceId: `app_${"z".repeat(26)}` };
    expect(await open().list()).toEqual([]); await expect(open().publish(encrypted.request.shareId)).rejects.toThrow(/source/);
    expect(record !== null).toBe(true);
  } finally { store.close(); }
});

it("rejects non-origin-bound or insecure sharing configuration", () => {
  const vault = {} as ShareOwnerVault; const source = vi.fn();
  expect(() => new ShareOwnerSession(vault, { baseUrl: "https://relay.example.test" } as ShareRelayClient, "https://app.example.test", "https://other.example.test", source)).toThrow(/configuration/);
  expect(() => new ShareOwnerSession(vault, { baseUrl: "http://public.example.test" } as ShareRelayClient, "https://app.example.test", "https://app.example.test", source)).toThrow(/configuration/);
});
