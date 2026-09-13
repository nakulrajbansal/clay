import { OwnedFactory } from "./helpers/owned-idb";
import { expect, it } from "vitest";
import { IndexedDbIntakeOwnerVault } from "../src/intake/owner-custody.browser";
import { prepareIntakeOwnerForm, hydrateIntakeOwnerForm } from "../src/intake/owner-custody";

function ownedInput(vault: IndexedDbIntakeOwnerVault): Parameters<typeof prepareIntakeOwnerForm>[0] {
  return { vault, formId: `form_${"g".repeat(26)}`, source: { appInstanceId: `app_${"a".repeat(26)}`, activeGenerationId: `gen_${"b".repeat(26)}`, lineageEpoch: "1", protectionRevision: "4",
    digestSchema: 1, stateSha256: `sha256:${"c".repeat(64)}` }, shellOrigin: "https://clay.example.test", relayBaseUrl: "https://relay.example.test/",
    title: "Owned IDB fixture", description: "", expiresAt: "2026-10-01T00:00:00.000Z", target: { tableId: "tbl_018f0000-0000-7000-8000-000000000001", expectedSchemaVersion: 1 },
    fields: [{ fieldId: "fld_018f0000-0000-7000-8000-000000000002", label: "Title", type: "text", required: true, maxLength: 100, options: [] }], fileRequests: [] };
}

it("waits for commit, preserves an existing winner, and reads the same custody after adapter reload", async () => {
  const factory = new OwnedFactory(); const vault = new IndexedDbIntakeOwnerVault(factory as unknown as IDBFactory);
  const input = ownedInput(vault); factory.failCommit = true;
  await expect(prepareIntakeOwnerForm(input)).rejects.toThrow(/custody/); expect(factory.rows.size).toBe(0);
  const form = await prepareIntakeOwnerForm(input); const reloaded = new IndexedDbIntakeOwnerVault(factory as unknown as IDBFactory);
  const owner = await hydrateIntakeOwnerForm(form, input.source, input.shellOrigin, reloaded);
  const key = [...factory.rows.keys()][0]!; const record = (await reloaded.read(key))!;
  const original = JSON.stringify(record);
  await reloaded.insert(record); // Exact replay is idempotent.
  const conflicted = { ...record, ownerToken: record.submitToken, submitToken: record.ownerToken };
  await expect(reloaded.insert(conflicted)).rejects.toThrow(/kept/);
  expect(JSON.stringify(await reloaded.read(key)) === original).toBe(true);
  expect(JSON.stringify(form).includes(owner.ownerPrivateKey)).toBe(false);
  expect(factory.rows.size).toBe(1); expect(factory.closes).toBe(factory.opens);
});

it("closes a late successful open after a blocked request has already failed", async () => {
  const factory = new OwnedFactory(); factory.blockNext = true;
  const vault = new IndexedDbIntakeOwnerVault(factory as unknown as IDBFactory);
  await expect(vault.read("owned-missing-key")).rejects.toThrow(/unavailable/);
  factory.lateSuccess!(); expect(factory.closes).toBe(1); expect(factory.rows.size).toBe(0);
});
