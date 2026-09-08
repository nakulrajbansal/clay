import type {
  CatalogRevisionReservationV1 as CatalogRevisionReservation,
  ProductionRequestReceiptV1 as ProductionRequestReceipt,
  TargetEvidenceV1 as TargetEvidence,
} from "@clay/schema/catalog";
import type { DbDriver } from "./db";
import { DeviceCatalog } from "./device-catalog";
import {
  SAMPLE_PROVENANCE_PREFIX,
  targetAuthorityInvalid as invalid,
} from "./production-input-capture";
import {
  decodeProductionResponse,
  type SampleProvenanceCoordinate,
} from "./production-response-envelope";
import { readCommittedSampleProducerReceipts } from "./production-request-journal";
import {
  productionOperationIdV2,
  sampleProducerRouteForOperationId,
  sampleProvenanceRouteForOperationId,
} from "./production-operation-id";
import { sha256HexSync } from "./state-digest";
import { ClayStore } from "./store";
import {
  TargetAuthorityStore,
  type ProtectionRevisionReservation,
} from "./target-authority";

export type SampleProvenanceLedgerEntry = SampleProvenanceCoordinate & Readonly<{
  operationId: string;
}>;

export type SampleProvenanceReceiptEvidence = Readonly<{
  receipt: ProductionRequestReceipt;
  responseJson: string | null;
}>;

export type SampleProvenanceProofInput = Readonly<{
  authorityIncarnationId: string;
  target: Readonly<{
    appInstanceId: string;
    activeGenerationId: string;
    lineageEpoch: string;
  }>;
  ledgerEntries: readonly SampleProvenanceLedgerEntry[];
  receipts: readonly SampleProvenanceReceiptEvidence[];
  catalogReceipts: readonly ProductionRequestReceipt[];
  targetReservations: readonly ProtectionRevisionReservation[];
  catalogReservations: readonly CatalogRevisionReservation[];
}>;

function coordinateKey(entry: SampleProvenanceLedgerEntry): string {
  return `${entry.operationId}\u0000${entry.tableId}\u0000${entry.rowId}`;
}

function responseDigest(json: string): string {
  return `sha256:${sha256HexSync(new TextEncoder().encode(json))}`;
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");
}

function receiptSignature(receipt: ProductionRequestReceipt): string {
  return JSON.stringify(Object.keys(receipt).sort().map(key =>
    [key, (receipt as unknown as Record<string, unknown>)[key]]));
}

function assertReceiptMirrors(input: SampleProvenanceProofInput): void {
  const targetReceipts = input.receipts.filter(item =>
    item.receipt.appInstanceId === input.target.appInstanceId
      && item.receipt.activeGenerationId === input.target.activeGenerationId
      && item.receipt.lineageEpoch === input.target.lineageEpoch);
  const catalogReceipts = input.catalogReceipts.filter(item =>
    item.appInstanceId === input.target.appInstanceId
      && item.activeGenerationId === input.target.activeGenerationId
      && item.lineageEpoch === input.target.lineageEpoch);
  if (targetReceipts.length !== catalogReceipts.length)
    throw invalid(SAMPLE_PROVENANCE_PREFIX + "receipt mirror is incomplete");
  const catalogByRequest = new Map<string, ProductionRequestReceipt>();
  for (const receipt of catalogReceipts) {
    if (catalogByRequest.has(receipt.requestId))
      throw invalid(SAMPLE_PROVENANCE_PREFIX + "receipt mirror is duplicated");
    catalogByRequest.set(receipt.requestId, receipt);
  }
  for (const target of targetReceipts) {
    const mirror = catalogByRequest.get(target.receipt.requestId);
    if (!mirror || receiptSignature(mirror) !== receiptSignature(target.receipt))
      throw invalid(SAMPLE_PROVENANCE_PREFIX + "receipt mirror is incomplete or divergent");
  }
}

function validateRouteResult(
  route: string,
  result: unknown,
  sampleProvenance: readonly SampleProvenanceCoordinate[],
): void {
  if (route === "starter.seed") {
    if (result !== null) throw invalid("starter seed provenance result is invalid");
    return;
  }
  const distinctTables = new Set<string>();
  for (let index = 0; index < sampleProvenance.length; index++)
    distinctTables.add(sampleProvenance[index]!.tableId);
  if (!exactObject(result, ["added", "tables"])
      || !Number.isSafeInteger(result.added) || Number(result.added) < 0
      || !Number.isSafeInteger(result.tables) || Number(result.tables) < 0
      || Number(result.tables) > Number(result.added)
      || Number(result.tables) !== distinctTables.size
      || Number(result.added) !== sampleProvenance.length
      || (Number(result.added) === 0) !== (Number(result.tables) === 0))
    throw invalid("sample fill provenance result is invalid");
}

function assertReservationPair(
  receipt: ProductionRequestReceipt,
  target: ProtectionRevisionReservation,
  catalog: CatalogRevisionReservation,
): void {
  if (receipt.resultingProtectionRevision === null || receipt.resultingStateSha256 === null
      || target.state !== "committed" || catalog.state !== "committed"
      || target.revision !== receipt.resultingProtectionRevision
      || catalog.revision !== receipt.resultingProtectionRevision
      || target.expectedProtectionRevision !== receipt.expectedProtectionRevision
      || catalog.expectedProtectionRevision !== receipt.expectedProtectionRevision
      || target.expectedStateSha256 !== receipt.expectedStateSha256
      || catalog.expectedStateSha256 !== receipt.expectedStateSha256
      || target.requestSha256 !== receipt.requestSha256
      || catalog.requestSha256 !== receipt.requestSha256
      || target.stateSha256 !== receipt.resultingStateSha256
      || catalog.stateSha256 !== receipt.resultingStateSha256
      || catalog.appInstanceId !== receipt.appInstanceId
      || catalog.activeGenerationId !== receipt.activeGenerationId
      || catalog.lineageEpoch !== receipt.lineageEpoch
      || catalog.publishedActiveGenerationId !== receipt.activeGenerationId
      || catalog.publishedLineageEpoch !== receipt.lineageEpoch
      || target.reservedAt !== receipt.preparedAt
      || catalog.reservedAt !== receipt.preparedAt
      || target.finalizedAt !== receipt.completedAt
      || catalog.finalizedAt !== receipt.completedAt)
    throw invalid(SAMPLE_PROVENANCE_PREFIX + "mirrored reservation evidence diverges");
}

function byOperation<T extends { operationId: string }>(
  rows: readonly T[],
): Map<string, T> {
  const result = new Map<string, T>();
  for (const row of rows) {
    if (result.has(row.operationId))
      throw invalid(SAMPLE_PROVENANCE_PREFIX + "reservation evidence is duplicated");
    result.set(row.operationId, row);
  }
  return result;
}

export function assertCommittedReceiptReservationBinding(
  receipt: ProductionRequestReceipt,
  targetReservations: readonly ProtectionRevisionReservation[],
  catalogReservations: readonly CatalogRevisionReservation[],
): void {
  const target = byOperation(targetReservations).get(receipt.operationId);
  const catalog = byOperation(catalogReservations).get(receipt.operationId);
  if (!target || !catalog)
    throw invalid(SAMPLE_PROVENANCE_PREFIX + "mirrored reservation evidence is incomplete");
  assertReservationPair(receipt, target, catalog);
}

export function assertAuthenticatedSampleProvenance(
  input: SampleProvenanceProofInput,
): void {
  assertReceiptMirrors(input);
  const targetByOperation = byOperation(input.targetReservations);
  const catalogByOperation = byOperation(input.catalogReservations);
  const ledger = new Set<string>();
  for (let index = 0; index < input.ledgerEntries.length; index++) {
    const key = coordinateKey(input.ledgerEntries[index]!);
    if (ledger.has(key)) throw invalid(SAMPLE_PROVENANCE_PREFIX + "ledger is duplicated");
    ledger.add(key);
  }

  const authenticated = new Set<string>();
  const producerOperations = new Set<string>();
  const orderedReceipts = [...input.receipts].sort((left, right) => {
    const leftRevision = left.receipt.resultingProtectionRevision;
    const rightRevision = right.receipt.resultingProtectionRevision;
    if (leftRevision === null) return rightRevision === null ? 0 : 1;
    if (rightRevision === null) return -1;
    return BigInt(leftRevision) < BigInt(rightRevision) ? -1
      : BigInt(leftRevision) > BigInt(rightRevision) ? 1 : 0;
  });
  for (let index = 0; index < orderedReceipts.length; index++) {
    const evidence = orderedReceipts[index]!;
    const receipt = evidence.receipt;
    if (receipt.appInstanceId !== input.target.appInstanceId) continue;
    const provenanceRoute = sampleProvenanceRouteForOperationId(
      input.authorityIncarnationId, receipt.requestId, receipt.operationId,
    );
    if (provenanceRoute === null) continue;
    if (evidence.responseJson === null)
      throw invalid(SAMPLE_PROVENANCE_PREFIX + "response is incomplete");
    if (receipt.responseSha256 === null
        || responseDigest(evidence.responseJson) !== receipt.responseSha256)
      throw invalid(SAMPLE_PROVENANCE_PREFIX + "response digest is invalid");
    const response = decodeProductionResponse(evidence.responseJson);
    if (response.kind === "legacy") {
      throw invalid(provenanceRoute === "starter.seed" || provenanceRoute === "samples.fill"
        ? "sample producer operation has unauthenticated legacy response evidence"
        : "sample promotion operation has unauthenticated legacy response evidence");
    }
    if (receipt.operationId !== productionOperationIdV2(
      input.authorityIncarnationId, receipt.requestId, response.route,
    )) throw invalid(SAMPLE_PROVENANCE_PREFIX + "operation is not bound to its response route");
    if (response.route !== provenanceRoute)
      throw invalid(SAMPLE_PROVENANCE_PREFIX + "operation is relabeled as another response route");
    const coordinates = response.sampleProvenance;
    if (coordinates === null) throw invalid(SAMPLE_PROVENANCE_PREFIX + "response is incomplete");
    if (receipt.activeGenerationId !== input.target.activeGenerationId
        || receipt.lineageEpoch !== input.target.lineageEpoch)
      throw invalid(SAMPLE_PROVENANCE_PREFIX + "receipt target is invalid");
    if (receipt.state !== "committed") {
      if (coordinates.length !== 0)
        throw invalid("noncommitted sample provenance receipt claims coordinates");
      continue;
    }
    const targetReservation = targetByOperation.get(receipt.operationId);
    const catalogReservation = catalogByOperation.get(receipt.operationId);
    if (!targetReservation || !catalogReservation)
      throw invalid(SAMPLE_PROVENANCE_PREFIX + "mirrored reservation evidence is incomplete");
    assertReservationPair(receipt, targetReservation, catalogReservation);

    const producerRoute = sampleProducerRouteForOperationId(
      input.authorityIncarnationId, receipt.requestId, receipt.operationId,
    );
    if (producerRoute !== null) {
      if (producerOperations.has(receipt.operationId))
        throw invalid(SAMPLE_PROVENANCE_PREFIX + "producer operation is duplicated");
      producerOperations.add(receipt.operationId);
      validateRouteResult(response.route, response.result, coordinates);
      for (let coordinateIndex = 0; coordinateIndex < coordinates.length; coordinateIndex++) {
        const coordinate = coordinates[coordinateIndex]!;
        const key = coordinateKey({ ...coordinate, operationId: receipt.operationId });
        if (authenticated.has(key))
          throw invalid(SAMPLE_PROVENANCE_PREFIX + "authenticated coordinate is duplicated");
        authenticated.add(key);
      }
      continue;
    }

    for (const coordinate of coordinates) {
      const suffix = `\u0000${coordinate.tableId}\u0000${coordinate.rowId}`;
      const matches = [...authenticated].filter(key => key.endsWith(suffix));
      if (matches.length !== 1)
        throw invalid(SAMPLE_PROVENANCE_PREFIX + "promotion is not bound to one active sample");
      authenticated.delete(matches[0]!);
    }
  }

  if (authenticated.size !== ledger.size)
    throw invalid(SAMPLE_PROVENANCE_PREFIX + "ledger and authenticated results diverge");
  for (const key of authenticated) {
    if (!ledger.has(key))
      throw invalid(SAMPLE_PROVENANCE_PREFIX + "ledger and authenticated results diverge");
  }
}

const STORE_GET_SETTING: ClayStore["getSetting"] = ClayStore.prototype.getSetting;
const STORE_SAMPLE_PROVENANCE: ClayStore["sampleRowProvenance"] =
  ClayStore.prototype.sampleRowProvenance;

export function assertLiveSampleProvenance(
  driver: DbDriver,
  store: ClayStore,
  target: TargetEvidence,
): readonly SampleProvenanceLedgerEntry[] {
  if (STORE_GET_SETTING.call(store, "sample_rows") !== undefined)
    throw invalid("legacy sample provenance is unauthenticated");
  const ledgerEntries = STORE_SAMPLE_PROVENANCE.call(store).map(entry =>
    Object.freeze({
      tableId: entry.tableId,
      rowId: entry.rowId,
      operationId: entry.operationId,
    }));
  const catalog = DeviceCatalog.openExisting(driver);
  const authorityIncarnationId = catalog.snapshot().authorityIncarnationId;
  const receipts = readCommittedSampleProducerReceipts(driver, {
    authorityIncarnationId,
    appInstanceId: target.appInstanceId,
    activeGenerationId: target.activeGenerationId,
    lineageEpoch: target.lineageEpoch,
  }).map(persisted => {
    const { responseJson, ...receipt } = persisted;
    return Object.freeze({ receipt, responseJson });
  });
  assertAuthenticatedSampleProvenance({
    authorityIncarnationId,
    target,
    ledgerEntries,
    receipts,
    catalogReceipts: receipts.map(item => item.receipt),
    targetReservations: TargetAuthorityStore.open(driver).reservations(),
    catalogReservations: catalog.revisionReservations(),
  });
  return Object.freeze(ledgerEntries);
}
