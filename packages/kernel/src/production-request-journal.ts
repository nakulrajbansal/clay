import { RequestId } from "@clay/schema";
import {
  ProductionRequestReceiptV1,
  type ProductionRequestReceiptV1 as ProductionRequestReceipt,
} from "@clay/schema/catalog";
import type { DbDriver, SqlRow, SqlValue } from "./db";
import { ClayError } from "./errors";
import { sha256HexSync } from "./state-digest";

const TARGET_TABLE = "sys.production_request_receipts";
const CATALOG_TABLE = "catalog.production_request_receipts";
const MAX_RESPONSE_BYTES = 2_000_000;

export type PersistedProductionRequestReceipt = ProductionRequestReceipt & {
  responseJson: string | null;
};

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
  const target = parseReceipt(targetRows[0]!);
  const catalog = parseReceipt(catalogRows[0]!);
  if (common(target) !== common(catalog))
    throw invalid("production request receipt mirrors diverged");
  const responseJson = nullableText(targetRows[0]!.response_json);
  if (target.responseSha256 === null) {
    if (responseJson !== null)
      throw invalid("nonterminal production receipt contains a response");
  } else {
    if (responseJson === null || responseDigest(responseJson) !== target.responseSha256)
      throw invalid("production request response hash is invalid");
  }
  return Object.freeze({ ...target, responseJson });
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
