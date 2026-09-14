import { expect, it, vi } from "vitest";
import { ClayStore, deriveInverse, openMemoryDriver, type ForwardOpT } from "../src/index";
import { ProductionStoreAuthority, productionLifecycleContext } from "../src/production-authority";
import { encodeProductionResponse } from "../src/production-response-envelope";
import { productionOperationIdV1 } from "../src/production-operation-id";
import type { LocalIntakeFormV2 } from "@clay/schema/intake";
import { ownedBrowserStorage } from "./helpers/owned-browser-storage";

const id = (kind: string, char: string) => `${kind}_${char.repeat(26)}`;
async function fixture() {
  const driver = await openMemoryDriver(); driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  const store = ClayStore.fromDriver(driver);
  const operations: ForwardOpT[] = [{ op: "create_table", table: "requests", columns: [{ name: "title", type: "text", required: true }] }];
  store.commit({ intent: "Synthetic owner witness", summary: "Owned fixture", migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) } });
  const table = store.validationRegistrySnapshot().get("requests")!;
  const authority = ProductionStoreAuthority.adoptLegacy(driver, { inventory: { state: "complete", catalogPresent: false,
    namespaces: [{ storageKey: "default", userFile: "/user.db", systemFile: "/system.db", kind: "legacy" }] }, storageKey: "default",
    displayName: "Owned witness", shellId: "blank", appInstanceId: id("app", "a"), generationId: id("gen", "b"), namespaceId: id("ns", "c"),
    adoptionOperationId: id("op", "d"), releaseId: id("rel", "e"), nowMs: Date.now(), leaseTtlMs: 60_000 });
  const source = authority.inspectAuthority().target;
  const form: LocalIntakeFormV2 = { schema: 2, ownerSource: { appInstanceId: source.appInstanceId, activeGenerationId: source.activeGenerationId, lineageEpoch: source.lineageEpoch },
    publicForm: { schema: 1, formId: id("form", "f"), revision: 1, title: "Synthetic owner", description: "", target: { tableId: table.semantic!.tableId, expectedSchemaVersion: store.currentVersion() },
      fields: [{ fieldId: table.columns.find(row => row.name === "title")!.semantic!.fieldId, label: "Title", type: "text", required: true, maxLength: 100, options: [] }], fileRequests: [],
      encryption: { algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM", ownerPublicKey: "A".repeat(87) }, delivery: { expiresAt: "2030-01-01T00:00:00.000Z" } },
    relayBaseUrl: "https://relay.example.test/", publishedAt: null, revokedAt: null, terminalReason: null };
  const requestId = authority.createRequestId();
  await authority.executeMutation({ requestId, route: "intake.command", payload: { authorityTarget: source, command: { route: "intake.saveForm", payload: { form } } } });
  return { authority, driver, claim: { schema: 1 as const, requestId, source, form } };
}

it("proves an original source from exact catalog/route/response metadata without selecting historical response bytes", async () => {
  const { authority, driver, claim } = await fixture();
  try {
    const select = driver.select.bind(driver);
    const calls = vi.spyOn(driver, "select").mockImplementation((sql, params) => {
      if (/response_json|SELECT\s+\*\s+FROM\s+sys\.production_request_receipts/i.test(sql)) throw new Error("Private read forbidden in public witness");
      return select(sql, params);
    });
    const result = await authority.intakeOwnerWitness(claim);
    expect(result).toMatchObject({ schema: 1, status: "live", claim, receipt: { requestId: claim.requestId, state: "committed" } });
    expect(JSON.stringify(result).includes("responseJson")).toBe(false);
    expect(calls.mock.calls.some(([sql]) => /catalog\.generations/.test(sql))).toBe(true);
  } finally { authority.close(); }
});

it("does not infer ownership from another request, generation, lineage, app, relay, key, or copied semantic IDs", async () => {
  const { authority, claim } = await fixture();
  try {
    const attempts = [
      { ...claim, requestId: id("req", "z") },
      { ...claim, source: { ...claim.source, appInstanceId: id("app", "z") }, form: { ...claim.form, ownerSource: { ...claim.form.ownerSource, appInstanceId: id("app", "z") } } },
      { ...claim, source: { ...claim.source, activeGenerationId: id("gen", "z") }, form: { ...claim.form, ownerSource: { ...claim.form.ownerSource, activeGenerationId: id("gen", "z") } } },
      { ...claim, form: { ...claim.form, relayBaseUrl: "https://other.example.test/" } },
      { ...claim, source: { ...claim.source, lineageEpoch: "2" }, form: { ...claim.form, ownerSource: { ...claim.form.ownerSource, lineageEpoch: "2" } } },
    ];
    for (const claim of attempts) await expect(authority.intakeOwnerWitness(claim)).rejects.toThrow(/owner.*proof|owner.*witness/i);
  } finally { authority.close(); }
});

it.each(["private", "malformed", "wrong_route", "legacy_public"])("keeps %s historical response identity untouched and refuses it as a public owner proof", async kind => {
  const { authority, driver, claim } = await fixture();
  try {
    // Fault injection changes only synthetic receipt bytes, never application or real custody data.
    const json = kind === "private" ? encodeProductionResponse("intake.command", { ...claim.form, ownerToken: "synthetic" }).json
      : kind === "malformed" ? "{invalid" : kind === "wrong_route" ? encodeProductionResponse("intake.saveForm", claim.form).json : JSON.stringify(claim.form);
    const { sha256HexSync } = await import("../src/state-digest");
    const digest = `sha256:${sha256HexSync(new TextEncoder().encode(json))}`;
    const context = productionLifecycleContext(authority);
    context.writeAuthority.run(() => {
      context.driver.exec("UPDATE sys.production_request_receipts SET response_json=?, response_sha256=? WHERE request_id=?", [json, digest, claim.requestId]);
      context.driver.exec("UPDATE catalog.production_request_receipts SET response_sha256=? WHERE request_id=?", [digest, claim.requestId]);
    });
    await expect(authority.intakeOwnerWitness(claim)).rejects.toThrow(/owner.*proof|owner.*witness/i);
    expect(driver.select("SELECT response_json FROM sys.production_request_receipts WHERE request_id=?", [claim.requestId])[0]?.response_json === json).toBe(true);
  } finally { authority.close(); }
});

it("does not grant a route witness to an unanchored operation or source-free V1 form", async () => {
  const { authority, driver, claim } = await fixture();
  try {
    const select = driver.select.bind(driver), operation = productionOperationIdV1(authority.inspectAuthority().catalog.authorityIncarnationId, claim.requestId);
    vi.spyOn(driver, "select").mockImplementation((sql, params) => {
      const rows = select(sql, params);
      return /FROM (?:sys|catalog)\.production_request_receipts WHERE request_id/.test(sql) ? rows.map(row => ({ ...row, operation_id: operation })) : rows;
    });
    await expect(authority.intakeOwnerWitness(claim)).rejects.toThrow(/owner.*proof|owner.*witness/i);
    const { ownerSource: _source, ...legacy } = claim.form;
    await expect(authority.intakeOwnerWitness({ ...claim, form: { ...legacy, schema: 1 } })).rejects.toThrow(/owner.*proof|owner.*witness/i);
  } finally { authority.close(); }
});

it("uses retained catalog creation and exact completed deletion history after the original files are gone; a fork never becomes the owner", async () => {
  const files = ownedBrowserStorage();
  let authority = await ProductionStoreAuthority.bootBrowser({ requestedAppId: null, appCache: [] });
  try {
    await authority.executeMutation({ requestId: authority.createRequestId(), route: "starter.seed", payload: {
      schema: 1, shellId: "tracker", shellName: "Owned witness", panels: [], tables: [{ name: "requests", columns: [{ name: "title", type: "text", required: true }], sampleRows: [] }],
    } });
    const source = authority.inspectAuthority().target, table = authority.activeSemanticRegistry().get("requests")!;
    const form: LocalIntakeFormV2 = { schema: 2, ownerSource: { appInstanceId: source.appInstanceId, activeGenerationId: source.activeGenerationId, lineageEpoch: source.lineageEpoch },
      publicForm: { schema: 1, formId: id("form", "r"), revision: 1, title: "Original owner", description: "", target: { tableId: table.semantic!.tableId, expectedSchemaVersion: authority.readStore().headVersion() },
        fields: [{ fieldId: table.columns.find(row => row.name === "title")!.semantic!.fieldId, label: "Title", type: "text", required: true, maxLength: 100, options: [] }], fileRequests: [],
        encryption: { algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM", ownerPublicKey: "A".repeat(87) }, delivery: { expiresAt: "2030-01-01T00:00:00.000Z" } },
      relayBaseUrl: "https://relay.example.test/", publishedAt: null, revokedAt: null, terminalReason: null };
    const claim = { schema: 1 as const, source, form, requestId: authority.createRequestId() };
    await authority.executeMutation({ requestId: claim.requestId, route: "intake.command", payload: { authorityTarget: source, command: { route: "intake.saveForm", payload: { form } } } });
    await expect(authority.intakeOwnerWitness(claim)).resolves.toMatchObject({ status: "live" });
    authority = await authority.executeAppLifecycle({ kind: "fork", requestId: authority.createRequestId() });
    const copy = authority.inspectAuthority().target;
    await expect(authority.intakeOwnerWitness(claim)).resolves.toMatchObject({ status: "history_only" });
    // A new fork does not copy original request response bytes. Catalog-only
    // metadata still proves public history, but must not fabricate a sealed body.
    expect((await authority.legacyOwnerInventory(null)).candidates.some(row => row.receipt.requestId === claim.requestId)).toBe(false);
    const originalWitness = await authority.intakeOwnerWitness(claim);
    const retained = { schema: 1 as const, authorityIncarnationId: originalWitness.authorityIncarnationId, route: "intake.command" as const,
      source, receipt: originalWitness.receipt };
    await expect(authority.withLegacyOwner(retained, async proof => proof)).rejects.toThrow(/quarantined/);
    await expect(authority.intakeOwnerWitness({ ...claim, source: copy, form: { ...form, ownerSource: {
      appInstanceId: copy.appInstanceId, activeGenerationId: copy.activeGenerationId, lineageEpoch: copy.lineageEpoch } } })).rejects.toThrow(/owner.*proof|owner.*witness/i);
    authority = await authority.executeAppLifecycle({ kind: "switch", requestId: authority.createRequestId(), appInstanceId: source.appInstanceId });
    authority = await authority.executeAppLifecycle({ kind: "delete", requestId: authority.createRequestId(), appInstanceId: source.appInstanceId });
    const { DeviceCatalog } = await import("../src/device-catalog");
    expect(DeviceCatalog.openExisting(productionLifecycleContext(authority).driver).completedOwnerRetirement(source.appInstanceId, source.activeGenerationId))
      .toMatchObject({ kind: "delete", requestedAppInstanceId: source.appInstanceId });
    await expect(authority.intakeOwnerWitness(claim)).resolves.toMatchObject({ status: "deleted" });
    const witness = await authority.intakeOwnerWitness(claim);
    expect(witness).toMatchObject({ status: "deleted", retirement: { kind: "delete", requestedAppInstanceId: source.appInstanceId } });
    await expect(authority.withLegacyOwner(retained, async proof => proof)).rejects.toThrow(/quarantined/);
    authority.close(); authority = await ProductionStoreAuthority.bootBrowser({ requestedAppId: null, appCache: [] });
    const reloaded = await authority.intakeOwnerWitness(claim);
    expect(reloaded.claim).toEqual(claim); expect(reloaded.receipt).toEqual(witness.receipt);
    expect(reloaded.retirement).toEqual(witness.retirement);
  } finally { authority.close(); files.close(); }
}, 30_000);
