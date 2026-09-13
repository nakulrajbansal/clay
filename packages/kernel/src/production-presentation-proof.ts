import type { ProductionResponseJson as JsonValue } from "./production-response-envelope";
import type { TargetEvidenceV1 } from "@clay/schema/catalog";
import type { DbDriver } from "./db";
import { ClayError } from "./errors";
import { DeviceCatalog } from "./device-catalog";
import { readProductionRequestReceipt } from "./production-request-journal";
import { decodeProductionResponse } from "./production-response-envelope";
import { productionOperationIdV2 } from "./production-operation-id";
import { TargetAuthorityStore } from "./target-authority";
import { assertCommittedReceiptReservationBinding } from "./sample-provenance-proof";
import { stableJson } from "./stable-json";
import { sha256HexSync } from "./state-digest";

/** Same canonical hash used by the coordinator, including the original expected
 * target, request ID, route and every payload byte. No current-target rebasing. */
export function productionJsonRequestFingerprint(expected: TargetEvidenceV1, request: JsonValue): string {
  return `sha256:${sha256HexSync(new TextEncoder().encode(stableJson({ schema: 1,
    expectedTarget: { appInstanceId: expected.appInstanceId, activeGenerationId: expected.activeGenerationId,
      lineageEpoch: expected.lineageEpoch, protectionRevision: expected.protectionRevision,
      digestSchema: expected.digestSchema, stateSha256: expected.stateSha256 }, request })))}`;
}

/** Original producer proof; the caller separately chooses whether exact current
 * state is required (invocation) or only original identity (terminal cancellation). */
export function originalPresentationResult(driver: DbDriver, current: TargetEvidenceV1,
  requestId: string, route: "daily.capture" | "schema.convertTextToRelation" | "daily.inbox", payload?: JsonValue) {
  const receipt = readProductionRequestReceipt(driver, requestId);
  const fail = (): never => { throw new ClayError("E_CONFLICT", "Original source receipt or payload binding differs; no Undo was performed"); };
  if (!receipt || receipt.state !== "committed" || !receipt.responseJson
      || receipt.appInstanceId !== current.appInstanceId || receipt.activeGenerationId !== current.activeGenerationId
      || receipt.lineageEpoch !== current.lineageEpoch || receipt.resultingProtectionRevision === null || receipt.resultingStateSha256 === null) return fail();
  const catalog = DeviceCatalog.openExisting(driver);
  if (receipt.operationId !== productionOperationIdV2(catalog.snapshot().authorityIncarnationId, requestId, route)) return fail();
  const expected = { appInstanceId: receipt.appInstanceId, activeGenerationId: receipt.activeGenerationId,
    lineageEpoch: receipt.lineageEpoch, protectionRevision: receipt.expectedProtectionRevision,
    digestSchema: 1 as const, stateSha256: receipt.expectedStateSha256 };
  if (payload !== undefined && receipt.requestSha256 !== productionJsonRequestFingerprint(expected, { requestId, route, payload })) return fail();
  assertCommittedReceiptReservationBinding(receipt, TargetAuthorityStore.open(driver).reservations(), catalog.revisionReservations());
  const response = decodeProductionResponse(receipt.responseJson);
  if (response.kind !== "envelope" || response.route !== route) return fail();
  return { result: response.result, target: { ...expected,
    protectionRevision: receipt.resultingProtectionRevision, stateSha256: receipt.resultingStateSha256 } };
}

export function assertExactPresentationTarget(original: TargetEvidenceV1, current: TargetEvidenceV1): void {
  if (stableJson(original) !== stableJson(current))
    throw new ClayError("E_CONFLICT", "Undo is bounded to its exact original source; intervening writes were kept");
}
