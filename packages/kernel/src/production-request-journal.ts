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
import {
  PRODUCTION_REQUEST_PREFIX,
  targetAuthorityInvalid as invalid,
} from "./production-input-capture";
import { sampleProducerRouteForOperationId } from "./production-operation-id";
import { sha256HexSync } from "./state-digest";

const TARGET_TABLE = "sys.production_request_receipts";
const CATALOG_TABLE = "catalog.production_request_receipts";
const RECEIPT_TABLES = [TARGET_TABLE, CATALOG_TABLE] as const;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_SAMPLE_ROUTE_SCAN_RECEIPTS = 100_000;
const MAX_SAMPLE_PRODUCER_RECEIPTS = 10_001;
const MAX_SAMPLE_PRODUCER_RESPONSE_BYTES = 8_000_000;

export type PersistedProductionRequestReceipt = ProductionRequestReceipt & {
  responseJson: string | null;
};

export type SampleProducerReceiptScope = Readonly<{
  authorityIncarnationId: string;
  appInstanceId: string;
  activeGenerationId: string;
  lineageEpoch: string;
}>;

function nullableText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw invalid(PRODUCTION_REQUEST_PREFIX + "receipt field is invalid");
  return value;
}

export function parseProductionRequestReceiptRow(row: SqlRow): ProductionRequestReceipt {
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
    throw invalid(PRODUCTION_REQUEST_PREFIX + "receipt row is invalid");
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
    throw invalid(PRODUCTION_REQUEST_PREFIX + "response exceeds the durable evidence limit");
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
  const target = parseProductionRequestReceiptRow(targetRow);
  const catalog = parseProductionRequestReceiptRow(catalogRow);
  if (common(target) !== common(catalog))
    throw invalid(PRODUCTION_REQUEST_PREFIX + "receipt mirrors diverged");
  const responseJson = nullableText(targetRow.response_json);
  if (target.responseSha256 === null) {
    if (responseJson !== null)
      throw invalid("nonterminal production receipt contains a response");
  } else if (responseJson === null || responseDigest(responseJson) !== target.responseSha256) {
    throw invalid(PRODUCTION_REQUEST_PREFIX + "response hash is invalid");
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
    throw invalid(PRODUCTION_REQUEST_PREFIX + "identity is invalid");
  const [targetRows, catalogRows] = RECEIPT_TABLES.map(table =>
    driver.select(`SELECT * FROM ${table} WHERE request_id=?`, [requestId]));
  if (targetRows!.length === 0 && catalogRows!.length === 0) return null;
  if (targetRows!.length !== 1 || catalogRows!.length !== 1)
    throw invalid(PRODUCTION_REQUEST_PREFIX + "receipt mirror is incomplete");
  return persistedFromRows(targetRows![0]!, catalogRows![0]!);
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
  const counts = RECEIPT_TABLES.map(table => {
    const summary = driver.select(
      `SELECT COUNT(*) AS receipt_count FROM ${table} WHERE ${where}`, queryParams,
    );
    const count = Number(summary[0]?.receipt_count);
    if (summary.length !== 1 || !Number.isSafeInteger(count) || count < 0)
      throw invalid("sample receipt route history summary is invalid");
    if (count > MAX_SAMPLE_ROUTE_SCAN_RECEIPTS)
      throw invalid("sample receipt route history exceeds its evidence limit");
    return count;
  });
  const targetCount = counts[0]!;
  const catalogCount = counts[1]!;
  if (targetCount !== catalogCount)
    throw invalid("sample producer receipt mirror is incomplete");
  const metadataRows = RECEIPT_TABLES.map((table, index) =>
    driver.select(
      `SELECT request_id,operation_id${index === 0 ? `,
       CASE WHEN response_json IS NULL THEN -1
         ELSE length(CAST(response_json AS BLOB)) END AS response_bytes` : ""}
     FROM ${table} WHERE ${where} ORDER BY request_id`,
      queryParams,
    ));
  const targetMetadataRows = metadataRows[0]!;
  const catalogMetadataRows = metadataRows[1]!;
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
  const rows = RECEIPT_TABLES.map((): SqlRow[] => []);
  for (let offset = 0; offset < requestIds.length; offset += 400) {
    const chunk = requestIds.slice(offset, offset + 400);
    const placeholders = chunk.map(() => "?").join(",");
    for (let index = 0; index < RECEIPT_TABLES.length; index++)
      rows[index]!.push(...driver.select(
        `SELECT * FROM ${RECEIPT_TABLES[index]} WHERE request_id IN (${placeholders})`, chunk,
      ));
  }
  const targetRows = rows[0]!;
  const catalogRows = rows[1]!;
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
    throw invalid(PRODUCTION_REQUEST_PREFIX + "receipt response is inconsistent");
  if (responseJson !== null && responseDigest(responseJson) !== receipt.responseSha256)
    throw invalid(PRODUCTION_REQUEST_PREFIX + "receipt response hash is inconsistent");
  const existing = readProductionRequestReceipt(driver, receipt.requestId);
  if (expectedState === null) {
    if (existing) throw invalid(PRODUCTION_REQUEST_PREFIX + "receipt already exists");
    if (receipt.state === "no_op") driver.exec(
      "INSERT INTO catalog.id_registry(id_value,id_kind,retained_at) VALUES (?,'operation',?)",
      [receipt.operationId, receipt.preparedAt],
    );
    const values = params(receipt);
    for (const table of RECEIPT_TABLES) {
      const target = table === TARGET_TABLE;
      const input = target ? [...values, responseJson] : values;
      driver.exec(
        `INSERT INTO ${table}(
          request_id,operation_id,request_sha256,app_instance_id,active_generation_id,
          lineage_epoch,expected_protection_revision,expected_state_sha256,state,
          resulting_protection_revision,resulting_state_sha256,response_sha256,
          prepared_at,invoked_at,completed_at${target ? ",response_json" : ""}
        ) VALUES (${input.map(() => "?").join(",")})`,
        input,
      );
    }
  } else {
    if (!existing || existing.state !== expectedState || immutable(existing) !== immutable(receipt))
      throw invalid(PRODUCTION_REQUEST_PREFIX + "receipt transition precondition failed");
    const mutable: SqlValue[] = [
      receipt.state,
      receipt.resultingProtectionRevision,
      receipt.resultingStateSha256,
      receipt.responseSha256,
      receipt.invokedAt,
      receipt.completedAt,
    ];
    for (const table of RECEIPT_TABLES) {
      const target = table === TARGET_TABLE;
      driver.exec(
        `UPDATE ${table} SET
          state=?,resulting_protection_revision=?,resulting_state_sha256=?,response_sha256=?,
          invoked_at=?,completed_at=?${target ? ",response_json=?" : ""}
         WHERE request_id=? AND state=?`,
        [...mutable, ...(target ? [responseJson] : []), receipt.requestId, expectedState],
      );
    }
  }
  const persisted = readProductionRequestReceipt(driver, receipt.requestId);
  if (!persisted || common(persisted) !== common(receipt)
      || persisted.responseJson !== responseJson)
    throw invalid(PRODUCTION_REQUEST_PREFIX + "receipt failed read-back");
  return persisted;
}
