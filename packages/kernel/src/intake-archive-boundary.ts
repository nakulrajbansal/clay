import type { DbDriver } from "./db";
import { ClayError } from "./errors";
import { parseIntakeState } from "./intake";
import { PRODUCTION_RESPONSE_PREFIX, decodeProductionResponse } from "./production-response-envelope";

/** Closed property-name inspection happens inside SQLite. No private value is
 * selected or rewritten, including escaped keys in historical JSON responses. */
export function assertNoLegacyIntakeArchive(driver: DbDriver): void {
  const unavailable = () => new ClayError("E_CONFLICT", "Legacy intake private custody is quarantined; original data and receipts were kept");
  if (driver.select("SELECT key FROM sys.settings WHERE key = 'intake_v1'").length) throw unavailable();
  if (driver.select("SELECT key FROM sys.settings WHERE key='intake_v2' AND NOT json_valid(value_json)").length) throw unavailable();
  if (driver.select(`SELECT setting.key FROM sys.settings AS setting WHERE setting.key='intake_v2'
    AND EXISTS (SELECT 1 FROM json_tree(setting.value_json) AS property
      WHERE property.key IN ('ownerPrivateKey','ownerToken','submitToken'))`).length) throw unavailable();
  // Only after the property-name boundary may V2 public metadata and user-owned
  // submissions be read for closed validation. No normalizer runs on this row.
  for (const row of driver.select("SELECT value_json FROM sys.settings WHERE key='intake_v2'")) {
    if (typeof row.value_json !== "string") throw unavailable();
    parseIntakeState(JSON.parse(row.value_json));
  }
  if (!driver.select("SELECT name FROM sys.sqlite_master WHERE type='table' AND name='production_request_receipts'").length) return;
  // Journal v1 stores a closed route prefix before its canonical JSON envelope.
  // Inspect keys inside SQLite BEFORE selecting any response value. Never filter
  // out failures, old JSON responses, or malformed physical rows.
  const body = `CASE WHEN substr(response_json,1,${PRODUCTION_RESPONSE_PREFIX.length})='${PRODUCTION_RESPONSE_PREFIX}'
    THEN substr(response_json,instr(response_json,char(10))+1) ELSE response_json END`;
  if (driver.select(`SELECT request_id FROM sys.production_request_receipts WHERE response_json IS NOT NULL AND NOT json_valid(${body}) LIMIT 1`).length) throw unavailable();
  if (driver.select(`SELECT receipt.request_id FROM (SELECT request_id, ${body} AS body FROM sys.production_request_receipts) AS receipt
    WHERE EXISTS (SELECT 1 FROM json_tree(receipt.body) AS property
      WHERE property.key IN ('ownerPrivateKey','ownerToken','submitToken')) LIMIT 1`).length) throw unavailable();
  if (driver.select("SELECT request_id FROM sys.production_request_receipts WHERE length(CAST(response_json AS BLOB)) > 2000000 LIMIT 1").length) throw unavailable();
  const expected = driver.select("SELECT count(*) AS n FROM sys.production_request_receipts WHERE response_json IS NOT NULL")[0]?.n;
  if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0 || expected > 100_000) throw unavailable();
  let after = "", parsed = 0;
  for (;;) {
    const page = driver.select("SELECT request_id, response_json FROM sys.production_request_receipts WHERE request_id > ? AND response_json IS NOT NULL ORDER BY request_id LIMIT 8", [after]);
    for (const row of page) {
      try { if (typeof row.response_json !== "string" || typeof row.request_id !== "string") throw unavailable(); decodeProductionResponse(row.response_json); after = row.request_id; parsed++; }
      catch { throw unavailable(); }
    }
    if (page.length < 8) break;
  }
  if (parsed !== expected) throw unavailable();
}
