import { IntakeOwnerClaimV1, IntakeOwnerWitnessV1 } from "@clay/schema/owner-witness";
import type { DbDriver } from "./db";
import { DeviceCatalog } from "./device-catalog";
import { TargetAuthorityStore } from "./target-authority";
import { ClayError } from "./errors";
import { parseProductionRequestReceiptRow } from "./production-request-journal";
import { productionOperationIdV2 } from "./production-operation-id";
import { productionJsonRequestFingerprint } from "./production-presentation-proof";
import { encodeProductionResponse } from "./production-response-envelope";
import { assertCommittedReceiptReservationBinding } from "./sample-provenance-proof";
import { stableJson } from "./stable-json";
import { captureAppLifecycleRequest, deriveLifecycleId, lifecycleRequestSha256 } from "./app-lifecycle-request";

const METADATA = `request_id,operation_id,request_sha256,app_instance_id,active_generation_id,lineage_epoch,
  expected_protection_revision,expected_state_sha256,state,resulting_protection_revision,resulting_state_sha256,
  response_sha256,prepared_at,invoked_at,completed_at`;
export const ownerWitnessUnavailable = () => new ClayError("E_CONFLICT", "Original owner witness proof is unavailable; original state and custody were kept");

/** This public path NEVER selects response_json. The claimed public response is
 * reconstructed and its exact byte hash checked against both durable mirrors.
 * A legacy private, raw/unprefixed, malformed or wrong-route response cannot be
 * made public by normalizing it under its old request identity. */
export function readIntakeOwnerWitness(driver: DbDriver, input: unknown): IntakeOwnerWitnessV1 {
  try {
    const claim = IntakeOwnerClaimV1.parse(input), source = claim.source;
    const catalog = DeviceCatalog.openExisting(driver), snapshot = catalog.snapshot();
    const target = TargetAuthorityStore.open(driver);
    const current = target.evidence();
    const entry = snapshot.entries.find(row => row.appInstanceId === source.appInstanceId);
    const retirement = catalog.completedOwnerRetirement(source.appInstanceId, source.activeGenerationId);
    if ((!entry && !retirement) || (entry && (entry.activeGenerationId !== source.activeGenerationId || entry.currentLineageEpoch !== source.lineageEpoch))) throw ownerWitnessUnavailable();
    if (retirement && (retirement.operationId !== deriveLifecycleId("op", snapshot.authorityIncarnationId, retirement.requestId, "lifecycle-operation")
        || retirement.requestSha256 !== lifecycleRequestSha256(captureAppLifecycleRequest({ kind: "delete", appInstanceId: source.appInstanceId, requestId: retirement.requestId })))) throw ownerWitnessUnavailable();
    const local = current.appInstanceId === source.appInstanceId && current.activeGenerationId === source.activeGenerationId && current.lineageEpoch === source.lineageEpoch;
    const rows = (local ? ["catalog", "sys"] : ["catalog"]).map(schema => driver.select(`SELECT ${METADATA} FROM ${schema}.production_request_receipts WHERE request_id=?`, [claim.requestId]));
    if (rows.some(list => list.length !== 1)) throw ownerWitnessUnavailable();
    const [receipt, mirror] = rows.map(list => parseProductionRequestReceiptRow(list[0]!));
    if (!receipt || (local && (!mirror || stableJson(receipt) !== stableJson(mirror))) || receipt.state !== "committed"
        || receipt.appInstanceId !== source.appInstanceId || receipt.activeGenerationId !== source.activeGenerationId || receipt.lineageEpoch !== source.lineageEpoch
        || receipt.expectedProtectionRevision !== source.protectionRevision || receipt.expectedStateSha256 !== source.stateSha256
        || receipt.operationId !== productionOperationIdV2(snapshot.authorityIncarnationId, claim.requestId, "intake.command")) throw ownerWitnessUnavailable();
    const payload = { authorityTarget: source, command: { route: "intake.saveForm", payload: { form: claim.form } } };
    if (receipt.requestSha256 !== productionJsonRequestFingerprint(source, { requestId: claim.requestId, route: "intake.command", payload })
        || receipt.responseSha256 !== encodeProductionResponse("intake.command", claim.form).sha256) throw ownerWitnessUnavailable();
    const reservations = catalog.revisionReservations();
    if (local) assertCommittedReceiptReservationBinding(receipt, target.reservations(), reservations);
    else {
      const matches = reservations.filter(row => row.operationId === receipt.operationId && row.state === "committed"
        && row.authorityIncarnationId === snapshot.authorityIncarnationId && row.appInstanceId === source.appInstanceId
        && row.activeGenerationId === source.activeGenerationId && row.lineageEpoch === source.lineageEpoch
        && row.expectedProtectionRevision === source.protectionRevision && row.expectedStateSha256 === source.stateSha256
        && row.requestSha256 === receipt.requestSha256 && row.revision === receipt.resultingProtectionRevision && row.stateSha256 === receipt.resultingStateSha256);
      if (matches.length !== 1) throw ownerWitnessUnavailable();
    }
    return IntakeOwnerWitnessV1.parse({ schema: 1, status: retirement ? "deleted" : local ? "live" : "history_only", authorityIncarnationId: snapshot.authorityIncarnationId,
      catalogGeneration: snapshot.catalogGeneration, claim, receipt, ...(retirement ? { retirement } : {}) });
  } catch { throw ownerWitnessUnavailable(); }
}
