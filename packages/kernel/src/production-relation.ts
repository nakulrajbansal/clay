import { z } from "zod";
import { TargetEvidenceV1, RelationPreviewPayloadV1, RelationKeepPayloadV1, RelationUndoPayloadV1 } from "@clay/schema/catalog";
import { ClayError } from "./errors";
import { PRODUCTION_STORE_PRIMITIVES, type ClayStore } from "./store";
import type { DbDriver } from "./db";
import { readProductionRequestReceipt } from "./production-request-journal";
import { decodeProductionResponse } from "./production-response-envelope";
import { productionOperationIdV2 } from "./production-operation-id";
import { DeviceCatalog } from "./device-catalog";
import { TargetAuthorityStore } from "./target-authority";
import { assertCommittedReceiptReservationBinding } from "./sample-provenance-proof";
import { assertExactPresentationTarget } from "./production-presentation-proof";

const name = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/);
export const RelationPreviewRequest = RelationPreviewPayloadV1;
const count = z.number().int().nonnegative().max(5_000);
export const RelationKeepRequest = RelationKeepPayloadV1;
export type CapturedRelationKeep = z.infer<typeof RelationKeepRequest>;
export const RelationUndoRequest = RelationUndoPayloadV1;
export type CapturedRelationUndo = z.infer<typeof RelationUndoRequest>;

export function undoRelation(store: ClayStore, driver: DbDriver, input: CapturedRelationUndo, target: TargetEvidenceV1) {
  if (input.authorityTarget) assertExactPresentationTarget(input.authorityTarget, target);
  const receipt = readProductionRequestReceipt(driver, input.conversionRequestId);
  if (!receipt || receipt.state !== "committed" || receipt.responseJson === null
      || receipt.appInstanceId !== target.appInstanceId || receipt.activeGenerationId !== target.activeGenerationId
      || receipt.lineageEpoch !== target.lineageEpoch || receipt.resultingProtectionRevision !== target.protectionRevision
      || receipt.resultingStateSha256 !== target.stateSha256)
    throw new ClayError("E_CONFLICT", "Conversion Undo is bounded to its exact committed state; intervening edits were kept");
  const response = decodeProductionResponse(receipt.responseJson);
  const parsed = z.object({ version: z.number().int().positive(), convertedRows: count, sourceField: name, relationField: name }).strict();
  if (response.kind !== "envelope" || response.route !== "schema.convertTextToRelation")
    throw new ClayError("E_CONFLICT", "Undo receipt is not a relation conversion");
  const catalog = DeviceCatalog.openExisting(driver);
  if (receipt.operationId !== productionOperationIdV2(catalog.snapshot().authorityIncarnationId,
    input.conversionRequestId, "schema.convertTextToRelation")) throw new ClayError("E_CONFLICT", "Conversion operation identity differs");
  assertCommittedReceiptReservationBinding(receipt, TargetAuthorityStore.open(driver).reservations(), catalog.revisionReservations());
  const result = parsed.parse(response.result);
  if (result.version !== input.beforeVersion + 1 || PRODUCTION_STORE_PRIMITIVES.headVersion.call(store) !== result.version)
    throw new ClayError("E_CONFLICT", "Conversion history changed; no structure was rewound");
  PRODUCTION_STORE_PRIMITIVES.rollbackTo.call(store, input.beforeVersion, { truncate: true });
  return { undone: true, version: input.beforeVersion };
}

export function keepRelation(store: ClayStore, input: CapturedRelationKeep, target: TargetEvidenceV1) {
  if (JSON.stringify(input.authorityTarget) !== JSON.stringify(TargetEvidenceV1.parse(target)))
    throw new ClayError("E_CONFLICT", "conversion preview target changed; preview again");
  const current = PRODUCTION_STORE_PRIMITIVES.previewRelationConversion.call(store, {
    sourceTable: input.sourceTable, sourceField: input.sourceField,
    targetTable: input.targetTable, displayField: input.displayField,
  });
  for (const key of Object.keys(current) as Array<keyof typeof current>)
    if (JSON.stringify(current[key]) !== JSON.stringify(input[key]))
      throw new ClayError("E_CONFLICT", "conversion preview changed; preview again");
  return PRODUCTION_STORE_PRIMITIVES.convertTextToRelation.call(store, input);
}
