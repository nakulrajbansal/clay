import {
  AppInstanceId,
  AuthorityIncarnationId,
  GenerationId,
  OperationId,
  RequestId,
  UInt64Decimal,
} from "@clay/schema";
import {
  ProductionRequestReceiptV1,
  type ProductionRequestReceiptV1 as ProductionRequestReceipt,
} from "@clay/schema/catalog";
import type { DbDriver, SqlRow, SqlValue } from "./db";
import { ClayError } from "./errors";
import { sampleProducerRouteForOperationId } from "./production-operation-id";
import { sha256HexSync } from "./state-digest";

const TARGET_TABLE = "sys.production_request_receipts";
const CATALOG_TABLE = "catalog.production_request_receipts";
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_SAMPLE_ROUTE_SCAN_RECEIPTS = 100_000;
const MAX_SAMPLE_PRODUCER_RECEIPTS = 10_001;
const MAX_SAMPLE_PRODUCER_RESPONSE_BYTES = 40 * 1024 * 1024;

export type PersistedProductionRequestReceipt = ProductionRequestReceipt & {
  responseJson: string | null;
};

export type SampleProducerReceiptScope = Readonly<{
  authorityIncarnationId: string;
  appInstanceId: string;
  activeGenerationId: string;
  lineageEpoch: string;
}>;

function invalid(message: string): ClayError {
  return new ClayError("E_TARGET_AUTHORITY_INVALID", message);
}

function nullableText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw invalid("production request receipt field is invalid");
  return value;
}

function parseReceipt(row: SqlRow): ProductionRequestReceipt {
  try {
    return ProductionRequestReceiptV1.parse({
      schema: 1,
      requestId: row.request_id,
      operationId: row.operation_id,
      requestSha256: row.request_sha256,
      appInstanceId: row.app_instance_id,
      activeGenerationId: row.active_generation_id,
      lineageEpoch: row.lineage_epoch,
      expectedProtectionRevision: row.expected_protection_revision,
      expectedStateSha256: row.expected_state_sha256,
      state: row.state,
      resultingProtectionRevision: nullableText(row.resulting_protection_revision),
      resultingStateSha256: nullableText(row.resulting_state_sha256),
      responseSha256: nullableText(row.response_sha256),
      preparedAt: row.prepared_at,
      invokedAt: nullableText(row.invoked_at),
      completedAt: nullableText(row.completed_at),
    });
  } catch {
    throw invalid("production request receipt row is invalid");
  }
}

function common(receipt: ProductionRequestReceipt): string {
  const schemaValue = { ...receipt } as Record<string, unknown>;
  delete schemaValue.responseJson;
  return JSON.stringify(ProductionRequestReceiptV1.parse(schemaValue));
}

function responseDigest(json: string): string {
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > MAX_RESPONSE_BYTES)
    throw invalid("production request response exceeds the durable evidence limit");
  return `sha256:${sha256HexSync(bytes)}`;
}

function immutable(receipt: ProductionRequestReceipt): string {
  return JSON.stringify({
    requestId: receipt.requestId,
    operationId: receipt.operationId,
    requestSha256: receipt.requestSha256,
    appInstanceId: receipt.appInstanceId,
    activeGenerationId: receipt.activeGenerationId,
    lineageEpoch: receipt.lineageEpoch,
    expectedProtectionRevision: receipt.expectedProtectionRevision,
    expectedStateSha256: receipt.expectedStateSha256,
    preparedAt: receipt.preparedAt,
  });
}

function persistedFromRows(
  targetRow: SqlRow,
  catalogRow: SqlRow,
): PersistedProductionRequestReceipt {
  const target = parseReceipt(targetRow);
  const catalog = parseReceipt(catalogRow);
  if (common(target) !== common(catalog))
    throw invalid("production request receipt mirrors diverged");
  const responseJson = nullableText(targetRow.response_json);
  if (target.responseSha256 === null) {
    if (responseJson !== null)
      throw invalid("nonterminal production receipt contains a response");
  } else if (responseJson === null || responseDigest(responseJson) !== target.responseSha256) {
    throw invalid("production request response hash is invalid");
  }
  return Object.freeze({ ...target, responseJson });
}

function params(receipt: ProductionRequestReceipt): SqlValue[] {
  return [
    receipt.requestId,
    receipt.operationId,
    receipt.requestSha256,
    receipt.appInstanceId,
    receipt.activeGenerationId,
    receipt.lineageEpoch,
    receipt.expectedProtectionRevision,
    receipt.expectedStateSha256,
    receipt.state,
    receipt.resultingProtectionRevision,
    receipt.resultingStateSha256,
    receipt.responseSha256,
    receipt.preparedAt,
    receipt.invokedAt,
    receipt.completedAt,
  ];
}

export function readProductionRequestReceipt(
  driver: DbDriver,
  requestId: string,
): PersistedProductionRequestReceipt | null {
  if (!RequestId.safeParse(requestId).success)
    throw invalid("production request identity is invalid");
  const targetRows = driver.select(
    `SELECT * FROM ${TARGET_TABLE} WHERE request_id=?`, [requestId],
  );
  const catalogRows = driver.select(
    `SELECT * FROM ${CATALOG_TABLE} WHERE request_id=?`, [requestId],
  );
  if (targetRows.length === 0 && catalogRows.length === 0) return null;
  if (targetRows.length !== 1 || catalogRows.length !== 1)
    throw invalid("production request receipt mirror is incomplete");
  return persistedFromRows(targetRows[0]!, catalogRows[0]!);
}

export function readCommittedSampleProducerReceipts(
  driver: DbDriver,
  input: SampleProducerReceiptScope,
): readonly PersistedProductionRequestReceipt[] {
  const authority = AuthorityIncarnationId.safeParse(input.authorityIncarnationId);
  const app = AppInstanceId.safeParse(input.appInstanceId);
  const generation = GenerationId.safeParse(input.activeGenerationId);
  const lineage = UInt64Decimal.safeParse(input.lineageEpoch);
  if (!authority.success || !app.success || !generation.success || !lineage.success)
    throw invalid("sample producer receipt scope is invalid");
  const where = `state='committed' AND app_instance_id=?
    AND active_generation_id=? AND lineage_epoch=?`;
  const queryParams: SqlValue[] = [app.data, generation.data, lineage.data];
  const targetSummary = driver.select(
    `SELECT COUNT(*) AS receipt_count FROM ${TARGET_TABLE} WHERE ${where}`,
    queryParams,
  );
  const targetCount = Number(targetSummary[0]?.receipt_count);
  if (targetSummary.length !== 1 || !Number.isSafeInteger(targetCount) || targetCount < 0)
    throw invalid("sample receipt route history summary is invalid");
  if (targetCount > MAX_SAMPLE_ROUTE_SCAN_RECEIPTS)
    throw invalid("sample receipt route history exceeds its evidence limit");
  const catalogSummary = driver.select(
    `SELECT COUNT(*) AS receipt_count FROM ${CATALOG_TABLE} WHERE ${where}`,
    queryParams,
  );
  const catalogCount = Number(catalogSummary[0]?.receipt_count);
  if (catalogSummary.length !== 1 || !Number.isSafeInteger(catalogCount) || catalogCount < 0)
    throw invalid("sample receipt route history summary is invalid");
  if (catalogCount > MAX_SAMPLE_ROUTE_SCAN_RECEIPTS)
    throw invalid("sample receipt route history exceeds its evidence limit");
  if (targetCount !== catalogCount)
    throw invalid("sample producer receipt mirror is incomplete");
  const targetMetadataRows = driver.select(
    `SELECT request_id,operation_id,
       CASE WHEN response_json IS NULL THEN -1
         ELSE length(CAST(response_json AS BLOB)) END AS response_bytes
     FROM ${TARGET_TABLE} WHERE ${where} ORDER BY request_id`,
    queryParams,
  );
  const catalogMetadataRows = driver.select(
    `SELECT request_id,operation_id
     FROM ${CATALOG_TABLE} WHERE ${where} ORDER BY request_id`,
    queryParams,
  );
  if (targetMetadataRows.length !== targetCount
      || catalogMetadataRows.length !== catalogCount)
    throw invalid("sample receipt route history changed during read");
  const catalogMetadataByRequest = new Map<string, string>();
  for (const row of catalogMetadataRows) {
    const request = RequestId.safeParse(row.request_id);
    const operation = OperationId.safeParse(row.operation_id);
    if (!request.success || !operation.success
        || catalogMetadataByRequest.has(request.data))
      throw invalid("sample receipt mirror metadata is invalid or duplicated");
    catalogMetadataByRequest.set(request.data, operation.data);
  }
  const producers: Array<{ requestId: string; responseBytes: number }> = [];
  const targetMetadataRequests = new Set<string>();
  let producerResponseBytes = 0;
  for (const row of targetMetadataRows) {
    const request = RequestId.safeParse(row.request_id);
    const operation = OperationId.safeParse(row.operation_id);
    const responseBytes = Number(row.response_bytes);
    if (!request.success || !operation.success
        || !Number.isSafeInteger(responseBytes) || responseBytes < 0)
      throw invalid("sample receipt route metadata is invalid");
    if (targetMetadataRequests.has(request.data))
      throw invalid("sample receipt target metadata is duplicated");
    targetMetadataRequests.add(request.data);
    if (catalogMetadataByRequest.get(request.data) !== operation.data)
      throw invalid("sample producer receipt mirror metadata diverged");
    if (sampleProducerRouteForOperationId(
      authority.data, request.data, operation.data,
    ) === null) continue;
    producers.push({ requestId: request.data, responseBytes });
    producerResponseBytes += responseBytes;
    if (!Number.isSafeInteger(producerResponseBytes))
      throw invalid("sample producer response history is invalid");
  }
  if (catalogMetadataByRequest.size !== targetMetadataRequests.size)
    throw invalid("sample producer receipt mirror metadata diverged");
  if (producers.length > MAX_SAMPLE_PRODUCER_RECEIPTS
      || producerResponseBytes > MAX_SAMPLE_PRODUCER_RESPONSE_BYTES)
    throw invalid("sample producer receipt history exceeds its evidence limit");
  const requestIds = producers.map(row => row.requestId);
  if (requestIds.length === 0) return Object.freeze([]);
  const targetRows: SqlRow[] = [];
  const catalogRows: SqlRow[] = [];
  for (let offset = 0; offset < requestIds.length; offset += 400) {
    const chunk = requestIds.slice(offset, offset + 400);
    const placeholders = chunk.map(() => "?").join(",");
    targetRows.push(...driver.select(
      `SELECT * FROM ${TARGET_TABLE} WHERE request_id IN (${placeholders})`, chunk,
    ));
    catalogRows.push(...driver.select(
      `SELECT * FROM ${CATALOG_TABLE} WHERE request_id IN (${placeholders})`, chunk,
    ));
  }
  if (targetRows.length !== requestIds.length || catalogRows.length !== requestIds.length)
    throw invalid("sample producer receipt mirror is incomplete or changed during read");
  const catalogByRequest = new Map<string, SqlRow>();
  for (const row of catalogRows) {
    if (typeof row.request_id !== "string" || catalogByRequest.has(row.request_id))
      throw invalid("sample producer receipt mirror is invalid or duplicated");
    catalogByRequest.set(row.request_id, row);
  }
  const receipts = targetRows.map(row => {
    const mirror = catalogByRequest.get(String(row.request_id));
    if (!mirror) throw invalid("sample producer receipt mirror is incomplete");
    return persistedFromRows(row, mirror);
  });
  return Object.freeze(receipts);
}

export function writeProductionRequestReceipt(
  driver: DbDriver,
  input: ProductionRequestReceipt,
  responseJson: string | null,
  expectedState: ProductionRequestReceipt["state"] | null,
): PersistedProductionRequestReceipt {
  const receipt = ProductionRequestReceiptV1.parse(input);
  if ((receipt.responseSha256 === null) !== (responseJson === null))
    throw invalid("production request receipt response is inconsistent");
  if (responseJson !== null && responseDigest(responseJson) !== receipt.responseSha256)
    throw invalid("production request receipt response hash is inconsistent");
  const existing = readProductionRequestReceipt(driver, receipt.requestId);
  if (expectedState === null) {
    if (existing) throw invalid("production request receipt already exists");
    driver.exec(
      `INSERT INTO ${TARGET_TABLE}(
        request_id,operation_id,request_sha256,app_instance_id,active_generation_id,
        lineage_epoch,expected_protection_revision,expected_state_sha256,state,
        resulting_protection_revision,resulting_state_sha256,response_sha256,
        prepared_at,invoked_at,completed_at,response_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [...params(receipt), responseJson],
    );
    driver.exec(
      `INSERT INTO ${CATALOG_TABLE}(
        request_id,operation_id,request_sha256,app_instance_id,active_generation_id,
        lineage_epoch,expected_protection_revision,expected_state_sha256,state,
        resulting_protection_revision,resulting_state_sha256,response_sha256,
        prepared_at,invoked_at,completed_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params(receipt),
    );
  } else {
    if (!existing || existing.state !== expectedState || immutable(existing) !== immutable(receipt))
      throw invalid("production request receipt transition precondition failed");
    const mutable: SqlValue[] = [
      receipt.state,
      receipt.resultingProtectionRevision,
      receipt.resultingStateSha256,
      receipt.responseSha256,
      receipt.invokedAt,
      receipt.completedAt,
    ];
    driver.exec(
      `UPDATE ${TARGET_TABLE} SET
        state=?,resulting_protection_revision=?,resulting_state_sha256=?,response_sha256=?,
        invoked_at=?,completed_at=?,response_json=?
       WHERE request_id=? AND state=?`,
      [...mutable, responseJson, receipt.requestId, expectedState],
    );
    driver.exec(
      `UPDATE ${CATALOG_TABLE} SET
        state=?,resulting_protection_revision=?,resulting_state_sha256=?,response_sha256=?,
        invoked_at=?,completed_at=?
       WHERE request_id=? AND state=?`,
      [...mutable, receipt.requestId, expectedState],
    );
  }
  const persisted = readProductionRequestReceipt(driver, receipt.requestId);
  if (!persisted || common(persisted) !== common(receipt)
      || persisted.responseJson !== responseJson)
    throw invalid("production request receipt failed read-back");
  return persisted;
}
