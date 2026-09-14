import { ClayStore, deriveInverse, openMemoryDriver, type ForwardOpT } from "../../src/index";
import { ProductionStoreAuthority, productionLifecycleContext } from "../../src/production-authority";
import { DeviceCatalog } from "../../src/device-catalog";
import { TargetAuthorityStore } from "../../src/target-authority";
import { StateMerkleIndex } from "../../src/state-merkle-index";
import { enumerateCanonicalStateV1 } from "../../src/canonical-state";
import { stateLeafHashV1 } from "../../src/state-merkle";
import { sha256HexSync } from "../../src/state-digest";
import { writeProductionRequestReceipt } from "../../src/production-request-journal";
import { encodeProductionResponse } from "../../src/production-response-envelope";
import { productionOperationIdV2 } from "../../src/production-operation-id";
import { productionJsonRequestFingerprint } from "../../src/production-presentation-proof";
import type { LocalIntakeFormV1 } from "@clay/schema/intake";

export const legacyId = (prefix: string, c: string) => `${prefix}_${c.repeat(26)}`;
/** Synthetic historical producer, using real catalog/target reservation and
 * receipt APIs. No mocked witness and no rewritten existing request identity.
 * Mirrors pre-49d1b77 intake.saveForm's payload/response and V1 setting write. */
export async function legacyIntakeHistory(makePrivate?: (form: LocalIntakeFormV1) => Promise<LocalIntakeFormV1>, encoding: "envelope" | "raw" = "envelope") {
  let driver = await openMemoryDriver(); const catalogFile = `/legacy-owned-${crypto.randomUUID()}.db`; driver.exec(`ATTACH '${catalogFile}' AS catalog`);
  const store = ClayStore.fromDriver(driver);
  const operations: ForwardOpT[] = [{ op: "create_table", table: "requests", columns: [{ name: "title", type: "text", required: true }] }];
  store.commit({ intent: "Synthetic history", summary: "Owned fixture", migration: { operations, inverse: deriveInverse(operations, store.registrySnapshot()) } });
  const table = store.validationRegistrySnapshot().get("requests")!;
  const inventory = { state: "complete" as const, catalogPresent: false, namespaces: [{ storageKey: "default", userFile: "/user.db", systemFile: "/system.db", kind: "legacy" as const }] };
  let authority = ProductionStoreAuthority.adoptLegacy(driver, { inventory, storageKey: "default", displayName: "Synthetic original", shellId: "blank",
    appInstanceId: legacyId("app", "a"), generationId: legacyId("gen", "b"), namespaceId: legacyId("ns", "c"), adoptionOperationId: legacyId("op", "d"),
    releaseId: legacyId("rel", "e"), nowMs: Date.now(), leaseTtlMs: 60_000 });
  let form: LocalIntakeFormV1 = { schema: 1, publicForm: { schema: 1, formId: legacyId("form", "f"), revision: 1, title: "Synthetic historical form", description: "",
    target: { tableId: table.semantic!.tableId, expectedSchemaVersion: store.currentVersion() },
    fields: [{ fieldId: table.columns.find(row => row.name === "title")!.semantic!.fieldId, label: "Title", type: "text", required: true, maxLength: 100, options: [] }], fileRequests: [],
    encryption: { algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM", ownerPublicKey: "A".repeat(87) },
    delivery: { expiresAt: "2030-01-01T00:00:00.000Z", submitToken: "A".repeat(43) } },
    ownerPrivateKey: "B".repeat(184), ownerToken: "C".repeat(43), relayBaseUrl: "https://relay.example.test/", publishedAt: null, revokedAt: null, terminalReason: null };
  if (makePrivate) form = await makePrivate(form);
  const original = JSON.stringify({ schema: 1, forms: [form], submissions: [], rules: [], simulations: [], receipts: [], deliveryFailures: [] });
  const source = authority.inspectAuthority().target, requestId = authority.createRequestId();
  const context = productionLifecycleContext(authority);
  context.writeAuthority.run(() => context.driver.tx(() => {
    const catalog = DeviceCatalog.openExisting(context.driver), target = TargetAuthorityStore.open(context.driver);
    const initial = catalog.snapshot(), at = new Date().toISOString();
    const fence = catalog.acquireWriteLease({ expectedAuthorityIncarnationId: initial.authorityIncarnationId, expectedCatalogGeneration: initial.catalogGeneration,
      expectedWriteEpoch: initial.writeEpoch, releaseId: legacyId("rel", "e"), nowMs: Date.parse(at), ttlMs: 60_000 });
    const route = "intake.saveForm", requestSha256 = productionJsonRequestFingerprint(source, { requestId, route, payload: { form } });
    const operationId = productionOperationIdV2(initial.authorityIncarnationId, requestId, route);
    target.reserveProtectionRevision(operationId, at, source, requestSha256);
    const reservation = catalog.reserveSelectedProtectionRevision({ expectedCatalogGeneration: catalog.snapshot().catalogGeneration, expectedTarget: source,
      operationId, requestSha256, fence, nowMs: Date.parse(at) });
    const prepared = { schema: 1 as const, requestId, operationId, requestSha256, appInstanceId: source.appInstanceId, activeGenerationId: source.activeGenerationId,
      lineageEpoch: source.lineageEpoch, expectedProtectionRevision: source.protectionRevision, expectedStateSha256: source.stateSha256, state: "prepared" as const,
      resultingProtectionRevision: null, resultingStateSha256: null, responseSha256: null, preparedAt: at, invokedAt: null, completedAt: null };
    writeProductionRequestReceipt(context.driver, prepared, null, null);
    const invoked = { ...prepared, state: "invoked" as const, invokedAt: at }; writeProductionRequestReceipt(context.driver, invoked, null, "prepared");
    const before = enumerateCanonicalStateV1(context.driver, store.validationRegistrySnapshot());
    context.driver.exec("INSERT INTO sys.settings(key,value_json) VALUES ('intake_v1',?)", [original]);
    const after = enumerateCanonicalStateV1(context.driver, store.validationRegistrySnapshot());
    const previous = new Map(before.leaves.map(row => [row.seed.key, stateLeafHashV1(row.seed.key, row.seed.fields)]));
    const changes = after.leaves.filter(row => previous.get(row.seed.key) !== stateLeafHashV1(row.seed.key, row.seed.fields)).map(row => row.seed);
    const committed = target.commitReservedProtectionRevision({ operationId, expectedTarget: source, finalizedAt: at, requestSha256, changes, mutate: () => undefined, registry: store.validationRegistrySnapshot() });
    catalog.publishSelectedTarget({ expectedCatalogGeneration: reservation.reservedCatalogGeneration, expectedTarget: source, publishedTarget: committed,
      operationId, requestSha256, fence, nowMs: Date.parse(at) });
    const json = encoding === "envelope" ? encodeProductionResponse(route, form).json : JSON.stringify(form);
    const encoded = { json, sha256: `sha256:${sha256HexSync(new TextEncoder().encode(json))}` };
    writeProductionRequestReceipt(context.driver, { ...invoked, state: "committed", resultingProtectionRevision: committed.protectionRevision,
      resultingStateSha256: committed.stateSha256, responseSha256: encoded.sha256, completedAt: at }, encoded.json, "invoked");
  }));
  const reopen = async () => {
    const copy = await driver.snapshot(); StateMerkleIndex.createSchema(copy); TargetAuthorityStore.createSchema(copy);
    for (const name of ["state_digest_leaves", "state_digest_buckets", "state_digest_root", "target_authority_header", "target_revision_reservations", "production_request_receipts"]) {
      for (const row of driver.select(`SELECT * FROM sys.${name}`)) {
        const keys = Object.keys(row); copy.exec(`INSERT INTO sys.${name}(${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`, keys.map(key => row[key]!));
      }
    }
    copy.exec(`ATTACH '${catalogFile}' AS catalog`); authority.close(); driver = copy;
    return authority = ProductionStoreAuthority.openExisting(driver, { inventory: { ...inventory, catalogPresent: true }, storageKey: "default",
      releaseId: legacyId("rel", "e"), nowMs: Date.now(), leaseTtlMs: 60_000 });
  };
  await reopen();
  return { get authority() { return authority; }, get driver() { return driver; }, form, original, source, requestId, reopen };
}
