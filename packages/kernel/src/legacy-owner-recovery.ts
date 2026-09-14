import { RequestId } from "@clay/schema/standalone/index";
import { LocalIntakeFormV1, LocalIntakeFormV2 } from "@clay/schema/standalone/intake";
import { LegacyOwnerCandidateV1, LegacyOwnerProofV1, LegacyOwnerInventoryV1, LegacyOwnerRouteV1 } from "@clay/schema/standalone/legacy-owner";
import type { DbDriver } from "./db";
import { DeviceCatalog } from "./device-catalog";
import { TargetAuthorityStore } from "./target-authority";
import { parseProductionRequestReceiptRow } from "./production-request-journal";
import { productionOperationIdV1, productionOperationIdV2 } from "./production-operation-id";
import { productionJsonRequestFingerprint } from "./production-presentation-proof";
import { assertCommittedReceiptReservationBinding } from "./sample-provenance-proof";
import { decodeProductionResponse } from "./production-response-envelope";
import { sha256HexSync } from "./state-digest";
import { stableJson } from "./stable-json";
import { ClayError } from "./errors";
import type { ClayStore } from "./store";
import { resolveIntakeForm } from "./intake";
import { captureAppLifecycleRequest, deriveLifecycleId, lifecycleRequestSha256 } from "./app-lifecycle-request";

const columns = "request_id,operation_id,request_sha256,app_instance_id,active_generation_id,lineage_epoch,expected_protection_revision,expected_state_sha256,state,resulting_protection_revision,resulting_state_sha256,response_sha256,prepared_at,invoked_at,completed_at";
const unavailable = () => new ClayError("E_CONFLICT", "Legacy owner recovery is unproven; original bytes remain quarantined and the app remains usable");
const sameOwner = (a: LegacyOwnerCandidateV1["source"], b: LegacyOwnerCandidateV1["source"]) => a.appInstanceId === b.appInstanceId && a.activeGenerationId === b.activeGenerationId && a.lineageEpoch === b.lineageEpoch;
function metadata(driver: DbDriver, candidate: LegacyOwnerCandidateV1) {
  const catalog = DeviceCatalog.openExisting(driver), current = catalog.snapshot(), target = TargetAuthorityStore.open(driver);
  if (current.authorityIncarnationId !== candidate.authorityIncarnationId) throw unavailable();
  const generation = driver.select("SELECT app_instance_id FROM catalog.generations WHERE generation_id=?", [candidate.source.activeGenerationId]);
  if (generation.length !== 1 || generation[0]!.app_instance_id !== candidate.source.appInstanceId) throw unavailable();
  if (!current.entries.some(entry => entry.appInstanceId === candidate.source.appInstanceId)) {
    const retired = catalog.completedOwnerRetirement(candidate.source.appInstanceId, candidate.source.activeGenerationId);
    if (!retired || retired.operationId !== deriveLifecycleId("op", current.authorityIncarnationId, retired.requestId, "lifecycle-operation")
        || retired.requestSha256 !== lifecycleRequestSha256(captureAppLifecycleRequest({ kind: "delete", requestId: retired.requestId, appInstanceId: candidate.source.appInstanceId }))) throw unavailable();
  }
  const local = sameOwner(target.evidence(), candidate.source) && sameOwner(catalog.selectedTargetStorage().target, candidate.source);
  const rows = ["catalog", "sys"].map(schema => driver.select(`SELECT ${columns} FROM ${schema}.production_request_receipts WHERE request_id=?`, [candidate.receipt.requestId]));
  if (rows.some(page => page.length !== 1)) throw unavailable();
  const receipts = rows.map(page => parseProductionRequestReceiptRow(page[0]!));
  if (receipts.some(r => stableJson(r) !== stableJson(candidate.receipt))
      || candidate.receipt.operationId !== productionOperationIdV2(current.authorityIncarnationId, candidate.receipt.requestId, candidate.route)) throw unavailable();
  if (local) assertCommittedReceiptReservationBinding(candidate.receipt, target.reservations(), catalog.revisionReservations());
  else {
    // A copied response is usable only with the ORIGINAL retained catalog's
    // exact closed creation history. It never makes the selected copy its owner.
    const r = candidate.receipt;
    const matches = catalog.revisionReservations().filter(row => row.operationId === r.operationId && row.authorityIncarnationId === candidate.authorityIncarnationId
      && row.state === "committed" && row.appInstanceId === r.appInstanceId && row.activeGenerationId === r.activeGenerationId && row.lineageEpoch === r.lineageEpoch
      && row.publishedActiveGenerationId === r.activeGenerationId && row.publishedLineageEpoch === r.lineageEpoch && row.revision === r.resultingProtectionRevision
      && row.requestSha256 === r.requestSha256 && row.expectedProtectionRevision === r.expectedProtectionRevision && row.expectedStateSha256 === r.expectedStateSha256
      && row.stateSha256 === r.resultingStateSha256 && row.reservedAt === r.preparedAt && row.finalizedAt === r.completedAt);
    if (matches.length !== 1) throw unavailable();
  }
  return local;
}

/** Bounded public pagination, including unproven rows; no private value selected.
 * Route membership comes from anchored operation IDs, NEVER response contents. */
export function legacyOwnerInventory(driver: DbDriver, after: unknown): LegacyOwnerInventoryV1 {
  try {
    const cursor = after === null ? "" : RequestId.parse(after), catalog = DeviceCatalog.openExisting(driver).snapshot();
    const target = TargetAuthorityStore.open(driver).evidence();
    const count = driver.select("SELECT count(*) AS n FROM sys.production_request_receipts")[0]?.n;
    if (typeof count !== "number" || count < 0 || count > 100_000 || !Number.isInteger(count)) throw unavailable();
    const rows = driver.select(`SELECT ${columns} FROM sys.production_request_receipts WHERE request_id>? ORDER BY request_id LIMIT 16`, [cursor]);
    const candidates: LegacyOwnerCandidateV1[] = []; let unproven = 0, previous = cursor;
    for (const row of rows) {
      const r = parseProductionRequestReceiptRow(row);
      if (r.requestId <= previous) throw unavailable(); previous = r.requestId;
      const route = LegacyOwnerRouteV1.options.find(route => productionOperationIdV2(catalog.authorityIncarnationId, r.requestId, route) === r.operationId);
      if (!route || r.state !== "committed") {
        if (route || r.operationId === productionOperationIdV1(catalog.authorityIncarnationId, r.requestId)) unproven++;
        continue;
      }
      const candidate = LegacyOwnerCandidateV1.parse({ schema: 1, authorityIncarnationId: catalog.authorityIncarnationId, route, receipt: r,
        source: { appInstanceId: r.appInstanceId, activeGenerationId: r.activeGenerationId, lineageEpoch: r.lineageEpoch,
          protectionRevision: r.expectedProtectionRevision, digestSchema: 1, stateSha256: r.expectedStateSha256 } });
      try { metadata(driver, candidate); candidates.push(candidate); } catch { unproven++; }
    }
    return LegacyOwnerInventoryV1.parse({ schema: 1, target, legacyState: driver.select("SELECT key FROM sys.settings WHERE key='intake_v1'").length > 0,
      candidates, next: rows.length === 16 ? previous : null, unproven });
  } catch { throw unavailable(); }
}

/** PACKAGE-PRIVATE sealed sink only. No worker RPC returns these bytes. Validate
 * original metadata first, exact bytes second, never rewrite historical identity. */
export async function withLegacyOwner<T>(driver: DbDriver, input: unknown, sink: (proof: LegacyOwnerProofV1, bytes: Uint8Array<ArrayBuffer>) => Promise<T>, store?: ClayStore): Promise<T> {
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    const candidate = LegacyOwnerCandidateV1.parse(input); const local = metadata(driver, candidate);
    const length = driver.select("SELECT length(CAST(response_json AS BLOB)) AS n FROM sys.production_request_receipts WHERE request_id=?", [candidate.receipt.requestId])[0]?.n;
    if (typeof length !== "number" || length < 1 || length > 2_000_000) throw unavailable();
    const row = driver.select("SELECT response_json FROM sys.production_request_receipts WHERE request_id=?", [candidate.receipt.requestId]);
    if (row.length !== 1 || typeof row[0]?.response_json !== "string") throw unavailable();
    const raw = row[0].response_json; bytes = new TextEncoder().encode(raw);
    if (bytes.byteLength !== length || `sha256:${sha256HexSync(bytes)}` !== candidate.receipt.responseSha256) throw unavailable();
    const decoded = decodeProductionResponse(raw);
    if (decoded.kind === "envelope" && decoded.route !== candidate.route) throw unavailable();
    const privateForm = LocalIntakeFormV1.safeParse(decoded.result), publicForm = LocalIntakeFormV2.safeParse(decoded.result);
    if (!privateForm.success && !publicForm.success) throw unavailable();
    const source = candidate.source;
    const form = privateForm.success ? LocalIntakeFormV2.parse({ schema: 2, ownerSource: { appInstanceId: source.appInstanceId, activeGenerationId: source.activeGenerationId, lineageEpoch: source.lineageEpoch },
      publicForm: { ...privateForm.data.publicForm, delivery: { expiresAt: privateForm.data.publicForm.delivery.expiresAt } },
      relayBaseUrl: privateForm.data.relayBaseUrl, publishedAt: privateForm.data.publishedAt, revokedAt: privateForm.data.revokedAt,
      terminalReason: privateForm.data.terminalReason ?? (privateForm.data.revokedAt ? "revoked" : null) }) : publicForm.data!;
    if (!sameOwner(form.ownerSource as typeof source, source)) throw unavailable();
    const operations = [
      { route: "intake.saveForm", payload: { form: decoded.result } },
      { route: "intake.markPublished", payload: { formId: form.publicForm.formId, publishedAt: form.publishedAt } },
      { route: "intake.revokeForm", payload: { formId: form.publicForm.formId, revokedAt: form.revokedAt } },
      { route: "intake.markExpired", payload: { formId: form.publicForm.formId, expiredAt: form.revokedAt } },
    ];
    const payloads = candidate.route === "intake.command" ? operations.map(command => ({ authorityTarget: source, command }))
      : operations.filter(command => command.route === candidate.route).map(command => command.payload);
    if (payloads.filter(payload => candidate.receipt.requestSha256 === productionJsonRequestFingerprint(source,
      { requestId: candidate.receipt.requestId, route: candidate.route, payload } as never)).length !== 1) throw unavailable();
    // Old snapshots may contain superseded definitions. Custody can be preserved
    // but activation must not resurrect a revoked/revised form or staged data.
    let activation: LegacyOwnerProofV1["activation"] = "custody_only";
    if (privateForm.success && local) try {
      const length = driver.select("SELECT length(CAST(value_json AS BLOB)) AS n FROM sys.settings WHERE key='intake_v1'")[0]?.n;
      if (typeof length === "number" && length <= 2_000_000) {
        const rawState = driver.select("SELECT value_json FROM sys.settings WHERE key='intake_v1'")[0]?.value_json;
        if (typeof rawState === "string") {
          const state = JSON.parse(rawState);
          if (state?.schema === 1 && Array.isArray(state.forms) && state.forms.length <= 100 && state.forms.every((f: unknown) => LocalIntakeFormV1.safeParse(f).success)
              && new Set(state.forms.map((f: LocalIntakeFormV1) => f.publicForm.formId)).size === state.forms.length
              && state.forms.some((f: LocalIntakeFormV1) => stableJson(f) === stableJson(decoded.result))) activation = "original_metadata";
        }
      }
      if (privateForm.data.revokedAt !== null && !privateForm.data.terminalReason) activation = "custody_only";
      // A V2 definition may already supersede this legacy form. Never downgrade
      // it or implicitly retarget an old schema review to today's fields.
      if (!store) activation = "custody_only";
      else {
        resolveIntakeForm(form.publicForm, store.validationRegistrySnapshot(), store.currentVersion());
        const active = driver.select("SELECT key FROM sys.settings WHERE key='intake_v2'").length
          ? store.listIntakeForms().find(row => row.publicForm.formId === form.publicForm.formId) : undefined;
        if (active && stableJson(active) !== stableJson(form)) activation = "custody_only";
      }
    } catch { activation = "custody_only"; }
    const proof = LegacyOwnerProofV1.parse({ ...candidate, kind: privateForm.success ? "intake_private" : "intake_public", form, activation });
    const result = await sink(proof, bytes); metadata(driver, candidate); return result;
  } catch { throw unavailable(); }
  finally { bytes?.fill(0); }
}
