import { expect, it } from "vitest";
import { ClayStore, deriveInverse, openMemoryDriver, type ForwardOpT } from "../src/index";
import { ProductionStoreAuthority } from "../src/production-authority";
import type { LocalIntakeFormV2 } from "@clay/schema/intake";

const id = (kind: string, char: string) => `${kind}_${char.repeat(26)}`;
async function fixture(legacy = false) {
  const driver = await openMemoryDriver(); driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  const store = ClayStore.fromDriver(driver);
  const ops: ForwardOpT[] = [{ op: "create_table", table: "requests", columns: [{ name: "title", type: "text", required: true }] }];
  store.commit({ intent: "Owned intake fixture", summary: "Owned target", migration: { operations: ops, inverse: deriveInverse(ops, store.registrySnapshot()) } });
  const table = store.validationRegistrySnapshot().get("requests")!;
  const form: LocalIntakeFormV2 = { schema: 2, ownerSource: { appInstanceId: id("app", "a"), activeGenerationId: id("gen", "b"), lineageEpoch: "1" },
    publicForm: { schema: 1, formId: id("form", "f"), revision: 1, title: "Owned form", description: "", target: { tableId: table.semantic!.tableId, expectedSchemaVersion: 0 },
      fields: [{ fieldId: table.columns.find(row => row.name === "title")!.semantic!.fieldId, label: "Title", type: "text", required: true, maxLength: 100, options: [] }],
      fileRequests: [], encryption: { algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM", ownerPublicKey: "A".repeat(87) }, delivery: { expiresAt: "2030-01-01T00:00:00.000Z" } },
    relayBaseUrl: "https://relay.example.test/", publishedAt: null, revokedAt: null, terminalReason: null };
  form.publicForm.target.expectedSchemaVersion = store.currentVersion();
  if (legacy) store.setSetting("intake_v1", { schema: 1, forms: [{ schema: 1, publicForm: { ...form.publicForm,
    delivery: { ...form.publicForm.delivery, submitToken: "s".repeat(43) } }, ownerPrivateKey: "A".repeat(184), ownerToken: "o".repeat(43),
    relayBaseUrl: form.relayBaseUrl, publishedAt: null, revokedAt: null }], submissions: [], rules: [], simulations: [], receipts: [], deliveryFailures: [] });
  const original = store.getSetting("intake_v1");
  const authority = ProductionStoreAuthority.adoptLegacy(driver, { inventory: { state: "complete", catalogPresent: false,
    namespaces: [{ storageKey: "default", userFile: "/user.db", systemFile: "/system.db", kind: "legacy" }] }, storageKey: "default", displayName: "Owned intake", shellId: "blank",
    appInstanceId: id("app", "a"), generationId: id("gen", "b"), namespaceId: id("ns", "c"), adoptionOperationId: id("op", "d"), releaseId: id("rel", "e"), nowMs: Date.now(), leaseTtlMs: 60_000 });
  const current = authority.inspectAuthority().target;
  form.ownerSource = { appInstanceId: current.appInstanceId, activeGenerationId: current.activeGenerationId, lineageEpoch: current.lineageEpoch };
  return { authority, driver, form, original };
}

it("persists and replays only secret-free source-bound form metadata", async () => {
  const { authority, form } = await fixture();
  try {
    const request = { requestId: authority.createRequestId(), route: "intake.command", payload: { authorityTarget: authority.inspectAuthority().target,
      command: { route: "intake.saveForm", payload: { form } } } };
    expect((await authority.executeMutation(request)).result).toEqual(form);
    expect((await authority.executeMutation(request)).replayed).toBe(true);
    expect(authority.readStore().listIntakeForms()).toEqual([form]);
    expect(await authority.mutationOutcome(request)).toMatchObject({ status: "recorded", result: form });
    await expect(authority.executeMutation({ ...request, requestId: authority.createRequestId() })).rejects.toThrow(/source/);
    const foreign = { ...form, publicForm: { ...form.publicForm, formId: id("form", "g") }, ownerSource: { ...form.ownerSource, appInstanceId: id("app", "z") } };
    await expect(authority.executeMutation({ requestId: authority.createRequestId(), route: "intake.command", payload: { authorityTarget: authority.inspectAuthority().target,
      command: { route: "intake.saveForm", payload: { form: foreign } } } })).rejects.toThrow(/source/);
  } finally { authority.close(); }
});

it("rejects legacy secret-bearing new writes before reserving or journaling a request", async () => {
  const { authority, driver, form } = await fixture();
  try {
    const before = authority.inspectAuthority();
    const result = await Promise.resolve().then(() => authority.executeMutation({ requestId: authority.createRequestId(), route: "intake.saveForm", payload: {
      form: { ...form, ownerPrivateKey: "A".repeat(184), ownerToken: "o".repeat(43) } } })).then(() => false, () => true);
    expect(result).toBe(true); expect(authority.inspectAuthority()).toEqual(before);
    expect(driver.select("SELECT request_id FROM sys.production_request_receipts")).toHaveLength(0);
  } finally { authority.close(); }
});

it("quarantines legacy state without returning, rewriting or exporting its private values", async () => {
  const { authority, driver, original } = await fixture(true);
  try {
    const denied = (() => { try { authority.readStore().listIntakeForms(); return false; } catch { return true; } })();
    expect(denied).toBe(true);
    expect(() => authority.readStore().getSetting("intake_v1")).toThrow(/custody/);
    await expect(authority.collectArchiveSnapshot()).rejects.toThrow(/custody/);
    const raw = driver.select("SELECT value_json FROM sys.settings WHERE key = 'intake_v1'")[0]!.value_json;
    expect(raw === JSON.stringify(original)).toBe(true);
  } finally { authority.close(); }
});

it("terminally fences unknown delayed publication IDs without deleting or relabeling the original form", async () => {
  const { authority, form } = await fixture();
  const command = (route: string, payload: unknown) => ({ requestId: authority.createRequestId(), route: "intake.command",
    payload: { authorityTarget: authority.inspectAuthority().target, command: { route, payload } } });
  try {
    const originalSave = command("intake.saveForm", { form });
    await authority.executeMutation(originalSave);
    const close = command("intake.closePublication", { form });
    const result = await authority.executeMutation(close);
    expect(result.result).toMatchObject({ terminal: true, form });
    expect((await authority.executeMutation(close)).replayed).toBe(true);
    expect(authority.readStore().listIntakeForms()).toEqual([form]);
    // Unknown IDs, even with a freshly read target, cannot resurrect the identity.
    await expect(authority.executeMutation(command("intake.markPublished", { formId: form.publicForm.formId, publishedAt: new Date().toISOString() }))).rejects.toThrow(/closed|terminal/);
    await expect(authority.executeMutation(command("intake.saveForm", { form: { ...form, publicForm: { ...form.publicForm, revision: 2 } } }))).rejects.toThrow(/closed|terminal/);
    expect(await authority.mutationOutcome(originalSave)).toMatchObject({ status: "recorded", result: form });
    expect((await authority.collectArchiveSnapshot()).target).toEqual(authority.inspectAuthority().target);
  } finally { authority.close(); }
});

it("closes an unsaved identity before a delayed old-client save, without creating a local form", async () => {
  const { authority, form } = await fixture();
  try {
    const originalSource = authority.inspectAuthority().target;
    await authority.executeMutation({ requestId: authority.createRequestId(), route: "intake.command", payload: {
      authorityTarget: originalSource, command: { route: "intake.closePublication", payload: { form } } } });
    expect(authority.readStore().listIntakeForms()).toEqual([]);
    for (const authorityTarget of [originalSource, authority.inspectAuthority().target]) {
      await expect(authority.executeMutation({ requestId: authority.createRequestId(), route: "intake.command", payload: {
        authorityTarget, command: { route: "intake.saveForm", payload: { form } } } })).rejects.toThrow(/source|closed|terminal/);
    }
  } finally { authority.close(); }
});

it("rejects wrong-source and changed-definition closure, keeping a published form active until explicit local revoke", async () => {
  const { authority, form } = await fixture();
  const run = (route: string, payload: unknown) => authority.executeMutation({ requestId: authority.createRequestId(), route: "intake.command",
    payload: { authorityTarget: authority.inspectAuthority().target, command: { route, payload } } });
  try {
    await run("intake.saveForm", { form });
    await run("intake.markPublished", { formId: form.publicForm.formId, publishedAt: new Date().toISOString() });
    await expect(run("intake.closePublication", { form: { ...form, ownerSource: { ...form.ownerSource, activeGenerationId: id("gen", "z") } } })).rejects.toThrow(/source/);
    await expect(run("intake.closePublication", { form: { ...form, publicForm: { ...form.publicForm, title: "Changed" } } })).rejects.toThrow(/identity|definition/);
    await run("intake.closePublication", { form });
    expect(authority.readStore().listIntakeForms()[0]?.revokedAt).toBeNull();
    await run("intake.revokeForm", { formId: form.publicForm.formId, revokedAt: new Date().toISOString() });
    expect(authority.readStore().listIntakeForms()[0]?.terminalReason).toBe("revoked");
  } finally { authority.close(); }
});

it("never permits a higher save revision to resurrect revoked form metadata", async () => {
  const { authority, form } = await fixture();
  const run = (route: string, payload: unknown) => authority.executeMutation({ requestId: authority.createRequestId(), route: "intake.command",
    payload: { authorityTarget: authority.inspectAuthority().target, command: { route, payload } } });
  try {
    await run("intake.saveForm", { form });
    await run("intake.markPublished", { formId: form.publicForm.formId, publishedAt: new Date().toISOString() });
    await run("intake.revokeForm", { formId: form.publicForm.formId, revokedAt: new Date().toISOString() });
    await expect(run("intake.saveForm", { form: { ...form, publicForm: { ...form.publicForm, revision: 2 } } })).rejects.toThrow(/terminal|revoked/);
  } finally { authority.close(); }
});

it("keeps the original terminal disposition under unknown delayed revoke IDs and fresh targets", async () => {
  const { authority, form } = await fixture();
  const run = (route: string, payload: unknown) => authority.executeMutation({ requestId: authority.createRequestId(), route: "intake.command",
    payload: { authorityTarget: authority.inspectAuthority().target, command: { route, payload } } });
  try {
    await run("intake.saveForm", { form });
    await run("intake.markPublished", { formId: form.publicForm.formId, publishedAt: new Date().toISOString() });
    const original = await run("intake.revokeForm", { formId: form.publicForm.formId, revokedAt: "2026-09-13T12:00:00.000Z" });
    const bytes = JSON.stringify(authority.readStore().listIntakeForms());
    const delayed = await run("intake.revokeForm", { formId: form.publicForm.formId, revokedAt: "2026-09-13T13:00:00.000Z" });
    expect(delayed.result).toEqual(original.result);
    expect(JSON.stringify(authority.readStore().listIntakeForms())).toBe(bytes);
  } finally { authority.close(); }
});
