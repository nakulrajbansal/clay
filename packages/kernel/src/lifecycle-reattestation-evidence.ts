import type { AppLifecycleReceiptV1, CatalogGenerationEventV1, CatalogRevisionReservationV1 } from "@clay/schema/catalog";
import { productionOperationIdV2 } from "./production-operation-id";
import { ClayError } from "./errors";

/** Exactly one internal sample re-attestation in the fresh install transaction,
 * never an arbitrary historical write suffix or a boolean 'replayed' claim. */
export function assertLifecycleReattestation(receipt: AppLifecycleReceiptV1,
  events: readonly CatalogGenerationEventV1[], reservations: readonly CatalogRevisionReservationV1[]): void {
  if (receipt.schema !== 2 || !receipt.initialPublication) return;
  const initial = receipt.initialPublication;
  const result = receipt.resultTarget;
  const operationId = productionOperationIdV2(receipt.authorityIncarnationId, initial.reattestationRequestId,
    receipt.kind === "restore" ? "archive.restore.samples" : "app.fork.samples");
  const suffix = events.filter(event => BigInt(event.catalogGeneration) > BigInt(initial.catalogGeneration)
    && BigInt(event.catalogGeneration) <= BigInt(receipt.completedCatalogGeneration));
  const reserved = reservations.find(item => item.operationId === operationId);
  if (suffix.length !== 2 || suffix[0]!.eventKind !== "revision_reserved" || suffix[1]!.eventKind !== "revision_committed"
      || suffix.some(event => event.operationId !== operationId || event.appInstanceId !== result.appInstanceId)
      || suffix[1]!.catalogGeneration !== receipt.completedCatalogGeneration || suffix[1]!.at !== receipt.completedAt
      || suffix.some(event => event.target !== null)
      || !reserved || reserved.state !== "committed" || reserved.finalizedCatalogGeneration !== receipt.completedCatalogGeneration
      || reserved.reservedCatalogGeneration !== suffix[0]!.catalogGeneration
      || reserved.appInstanceId !== initial.target.appInstanceId || reserved.activeGenerationId !== initial.target.activeGenerationId
      || reserved.lineageEpoch !== initial.target.lineageEpoch || reserved.expectedProtectionRevision !== initial.target.protectionRevision
      || reserved.expectedStateSha256 !== initial.target.stateSha256 || reserved.revision !== result.protectionRevision
      || reserved.publishedActiveGenerationId !== result.activeGenerationId || reserved.publishedLineageEpoch !== result.lineageEpoch
      || reserved.stateSha256 !== result.stateSha256 || initial.target.protectionRevision !== "0" || result.protectionRevision !== "1")
    throw new ClayError("E_CATALOG_UNAVAILABLE", "lifecycle re-attestation does not bind the exact initial and final target");
}
