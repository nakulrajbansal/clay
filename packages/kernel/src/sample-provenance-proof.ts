import type {
  CatalogRevisionReservationV1 as CatalogRevisionReservation,
  ProductionRequestReceiptV1 as ProductionRequestReceipt,
  TargetEvidenceV1 as TargetEvidence,
} from "@clay/schema/catalog";
import type { DbDriver } from "./db";
import { DeviceCatalog } from "./device-catalog";
import { ClayError } from "./errors";
import {
  decodeProductionResponse,
  type SampleProvenanceCoordinate,
} from "./production-response-envelope";
import { readCommittedSampleProducerReceipts } from "./production-request-journal";
import {
  productionOperationIdV2,
  sampleProducerRouteForOperationId,
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

function invalid(message: string): ClayError {
  return new ClayError("E_TARGET_AUTHORITY_INVALID", message);
}

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
    throw invalid("sample provenance receipt mirror is incomplete");
  const catalogByRequest = new Map<string, ProductionRequestReceipt>();
  for (const receipt of catalogReceipts) {
    if (catalogByRequest.has(receipt.requestId))
      throw invalid("sample provenance receipt mirror is duplicated");
    catalogByRequest.set(receipt.requestId, receipt);
  }
  for (const target of targetReceipts) {
    const mirror = catalogByRequest.get(target.receipt.requestId);
    if (!mirror || receiptSignature(mirror) !== receiptSignature(target.receipt))
      throw invalid("sample provenance receipt mirror is incomplete or divergent");
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
  authorityIncarnationId: string,
): void {
  if (receipt.resultingProtectionRevision === null || receipt.resultingStateSha256 === null
      || target.state !== "committed" || catalog.state !== "committed"
      || catalog.authorityIncarnationId !== authorityIncarnationId
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
    throw invalid("sample provenance mirrored reservation evidence diverges");
}

function byOperation<T extends { operationId: string }>(
  rows: readonly T[],
): Map<string, T> {
  const result = new Map<string, T>();
  for (const row of rows) {
    if (result.has(row.operationId))
      throw invalid("sample provenance reservation evidence is duplicated");
    result.set(row.operationId, row);
  }
  return result;
}

export function assertCommittedReceiptReservationBinding(
  receipt: ProductionRequestReceipt,
  targetReservations: readonly ProtectionRevisionReservation[],
  catalogReservations: readonly CatalogRevisionReservation[],
  authorityIncarnationId: string,
): void {
  const target = byOperation(targetReservations).get(receipt.operationId);
  const catalog = byOperation(catalogReservations).get(receipt.operationId);
  if (!target || !catalog)
    throw invalid("sample provenance mirrored reservation evidence is incomplete");
  assertReservationPair(receipt, target, catalog, authorityIncarnationId);
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
    if (ledger.has(key)) throw invalid("sample provenance ledger is duplicated");
    ledger.add(key);
  }

  const authenticated = new Set<string>();
  const producerOperations = new Set<string>();
  for (let index = 0; index < input.receipts.length; index++) {
    const evidence = input.receipts[index]!;
    const receipt = evidence.receipt;
    if (receipt.appInstanceId !== input.target.appInstanceId) continue;
    if (evidence.responseJson === null) continue;
    if (receipt.responseSha256 === null
        || responseDigest(evidence.responseJson) !== receipt.responseSha256)
      throw invalid("sample provenance response digest is invalid");
    const response = decodeProductionResponse(evidence.responseJson);
    const producerRoute = sampleProducerRouteForOperationId(
      input.authorityIncarnationId, receipt.requestId, receipt.operationId,
    );
    if (response.kind === "legacy") {
      if (producerRoute !== null)
        throw invalid("sample producer operation has unauthenticated legacy response evidence");
      continue;
    }
    if (receipt.operationId !== productionOperationIdV2(
      input.authorityIncarnationId, receipt.requestId, response.route,
    )) throw invalid("sample provenance operation is not bound to its response route");
    if (producerRoute === null) continue;
    if (response.route !== producerRoute)
      throw invalid("sample producer operation is relabeled as another response route");
    const coordinates = response.sampleProvenance;
    if (coordinates === null) throw invalid("sample provenance response is incomplete");
    if (receipt.activeGenerationId !== input.target.activeGenerationId
        || receipt.lineageEpoch !== input.target.lineageEpoch)
      throw invalid("sample provenance receipt target is invalid");
    if (receipt.state !== "committed") {
      if (coordinates.length !== 0)
        throw invalid("noncommitted sample provenance receipt claims coordinates");
      continue;
    }
    if (producerOperations.has(receipt.operationId))
      throw invalid("sample provenance producer operation is duplicated");
    producerOperations.add(receipt.operationId);
    validateRouteResult(response.route, response.result, coordinates);
    const targetReservation = targetByOperation.get(receipt.operationId);
    const catalogReservation = catalogByOperation.get(receipt.operationId);
    if (!targetReservation || !catalogReservation)
      throw invalid("sample provenance mirrored reservation evidence is incomplete");
    assertReservationPair(
      receipt, targetReservation, catalogReservation, input.authorityIncarnationId,
    );
    for (let coordinateIndex = 0; coordinateIndex < coordinates.length; coordinateIndex++) {
      const coordinate = coordinates[coordinateIndex]!;
      const key = coordinateKey({ ...coordinate, operationId: receipt.operationId });
      if (authenticated.has(key))
        throw invalid("sample provenance authenticated coordinate is duplicated");
      authenticated.add(key);
    }
  }

  if (authenticated.size !== ledger.size)
    throw invalid("sample provenance operation binding failed: ledger and authenticated results diverge");
  for (const key of authenticated) {
    if (!ledger.has(key))
      throw invalid("sample provenance operation binding failed: ledger and authenticated results diverge");
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
