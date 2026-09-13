import { expect, it, vi } from "vitest";
import { prepareIntakeOwnerForm, hydrateIntakeOwnerForm, type IntakeOwnerVault, type IntakeOwnerCustody } from "../src/intake/owner-custody";
import { LocalIntakeFormV2 } from "@clay/schema/intake";
import { generateIntakeOwnerKeyPair } from "../src/intake/crypto";

function ownedInput(vault: IntakeOwnerVault): Parameters<typeof prepareIntakeOwnerForm>[0] {
  return { formId: `form_${"f".repeat(26)}`, source: { appInstanceId: `app_${"a".repeat(26)}`, activeGenerationId: `gen_${"b".repeat(26)}`, lineageEpoch: "1", protectionRevision: "4",
    digestSchema: 1, stateSha256: `sha256:${"c".repeat(64)}` }, shellOrigin: "https://clay.example.test", vault, relayBaseUrl: "https://relay.example.test/",
    title: "Original review", description: "", expiresAt: "2026-10-01T00:00:00.000Z", target: { tableId: "tbl_018f0000-0000-7000-8000-000000000001", expectedSchemaVersion: 1 },
    fields: [{ fieldId: "fld_018f0000-0000-7000-8000-000000000002", label: "Title", type: "text", required: true, maxLength: 100, options: [] }], fileRequests: [] };
}

it("captures the reviewed metadata before the first asynchronous custody read", async () => {
  let record: IntakeOwnerCustody | null = null; let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; }); let reads = 0;
  const vault: IntakeOwnerVault = { read: async () => { if (++reads === 1) await barrier; return structuredClone(record); },
    insert: async value => { record = structuredClone(value); } };
  const input = ownedInput(vault); const pending = prepareIntakeOwnerForm(input);
  input.title = "Changed after invocation"; input.fields[0]!.label = "Different field label"; release();
  const form = await pending;
  expect(form.publicForm.title).toBe("Original review"); expect(form.publicForm.fields[0]!.label).toBe("Title");
});

it("rejects corrupted private custody before returning delivery capabilities", async () => {
  let record: IntakeOwnerCustody | null = null;
  const vault: IntakeOwnerVault = { read: async () => structuredClone(record), insert: async value => { record = structuredClone(value); } };
  const input = ownedInput(vault); const form = await prepareIntakeOwnerForm(input);
  const unrelated = await generateIntakeOwnerKeyPair();
  record = { ...record!, ownerPrivateKey: unrelated.privateKey };
  // Never let an assertion formatter print capability-bearing resolved values.
  const hydrateRejected = await hydrateIntakeOwnerForm(form, input.source, input.shellOrigin, vault).then(() => false, () => true);
  const retryRejected = await prepareIntakeOwnerForm(input).then(() => false, () => true);
  expect(hydrateRejected).toBe(true); expect(retryRejected).toBe(true);
});

it("keeps private and submit/owner capabilities outside metadata and binds custody to original app, generation and origins", async () => {
  const rows = new Map<string, IntakeOwnerCustody>();
  const vault: IntakeOwnerVault = { read: vi.fn(async key => structuredClone(rows.get(key) ?? null)),
    insert: async record => { if (rows.has(record.key)) throw new Error("Owned duplicate"); rows.set(record.key, structuredClone(record)); } };
  const source = { appInstanceId: `app_${"a".repeat(26)}`, activeGenerationId: `gen_${"b".repeat(26)}`, lineageEpoch: "1", protectionRevision: "4",
    digestSchema: 1 as const, stateSha256: `sha256:${"c".repeat(64)}` };
  const form = await prepareIntakeOwnerForm({ source, formId: `form_${"d".repeat(26)}`, shellOrigin: "https://clay.example.test", vault, relayBaseUrl: "https://relay.example.test/",
    title: "Owned request", description: "Synthetic fixture", expiresAt: "2026-10-01T00:00:00.000Z",
    target: { tableId: "tbl_018f0000-0000-7000-8000-000000000001", expectedSchemaVersion: 1 },
    fields: [{ fieldId: "fld_018f0000-0000-7000-8000-000000000002", label: "Title", type: "text", required: true, maxLength: 100, options: [] }], fileRequests: [] });
  expect(LocalIntakeFormV2.safeParse(form).success).toBe(true);
  const owner = await hydrateIntakeOwnerForm(form, source, "https://clay.example.test", vault);
  const metadata = JSON.stringify(form);
  // Boolean assertions never print generated capability or key bytes on failure.
  expect([owner.ownerPrivateKey, owner.ownerToken, owner.publicForm.delivery.submitToken].some(value => metadata.includes(value))).toBe(false);
  expect(LocalIntakeFormV2.safeParse({ ...form, ownerToken: owner.ownerToken }).success).toBe(false);
  await expect(hydrateIntakeOwnerForm(form, { ...source, appInstanceId: `app_${"z".repeat(26)}` }, "https://clay.example.test", vault)).rejects.toThrow(/source/);
  await expect(hydrateIntakeOwnerForm(form, { ...source, activeGenerationId: `gen_${"z".repeat(26)}` }, "https://clay.example.test", vault)).rejects.toThrow(/source/);
  await expect(hydrateIntakeOwnerForm(form, source, "https://other.example.test", vault)).rejects.toThrow(/custody/);
  await expect(hydrateIntakeOwnerForm({ ...form, relayBaseUrl: "https://other-relay.example.test/" }, source, "https://clay.example.test", vault)).rejects.toThrow(/custody/);
  expect(rows.size).toBe(1);
});

it("does not present a form when private custody failed to commit", async () => {
  const vault: IntakeOwnerVault = { read: async () => null, insert: async () => { throw new Error("Owned vault commit fault"); } };
  await expect(prepareIntakeOwnerForm({ formId: `form_${"d".repeat(26)}`, source: { appInstanceId: `app_${"a".repeat(26)}`, activeGenerationId: `gen_${"b".repeat(26)}`, lineageEpoch: "1", protectionRevision: "4",
    digestSchema: 1, stateSha256: `sha256:${"c".repeat(64)}` }, shellOrigin: "https://clay.example.test", vault, relayBaseUrl: "https://relay.example.test/",
    title: "Owned request", description: "", expiresAt: "2026-10-01T00:00:00.000Z", target: { tableId: "tbl_018f0000-0000-7000-8000-000000000001", expectedSchemaVersion: 1 },
    fields: [{ fieldId: "fld_018f0000-0000-7000-8000-000000000002", label: "Title", type: "text", required: true, maxLength: 100, options: [] }], fileRequests: [] })).rejects.toThrow(/custody/);
});

it("reconciles an ambiguous custody commit using the retained form identity without replacing material", async () => {
  let record: IntakeOwnerCustody | null = null; let inserts = 0;
  const vault: IntakeOwnerVault = { read: async () => structuredClone(record), insert: async value => {
    record = structuredClone(value); inserts++; throw new Error("Owned lost commit response");
  } };
  const input: Parameters<typeof prepareIntakeOwnerForm>[0] = {
    formId: `form_${"e".repeat(26)}`, source: { appInstanceId: `app_${"a".repeat(26)}`, activeGenerationId: `gen_${"b".repeat(26)}`, lineageEpoch: "1", protectionRevision: "4",
      digestSchema: 1, stateSha256: `sha256:${"c".repeat(64)}` }, shellOrigin: "https://clay.example.test", vault, relayBaseUrl: "https://relay.example.test/",
    title: "Original retained review", description: "", expiresAt: "2026-10-01T00:00:00.000Z", target: { tableId: "tbl_018f0000-0000-7000-8000-000000000001", expectedSchemaVersion: 1 },
    fields: [{ fieldId: "fld_018f0000-0000-7000-8000-000000000002", label: "Title", type: "text", required: true, maxLength: 100, options: [] }], fileRequests: [] };
  await expect(prepareIntakeOwnerForm(input)).rejects.toThrow(/custody/);
  expect((await prepareIntakeOwnerForm(input)).publicForm.formId).toBe(input.formId);
  expect(inserts).toBe(1);
  await expect(prepareIntakeOwnerForm({ ...input, title: "Different review" })).rejects.toThrow(/custody/);
  expect(inserts).toBe(1);
});
