import type { DbDriver } from "./db";
import { ClayError } from "./errors";
import { parseIntakeState } from "./intake";

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
  // Invalid JSON is not an excuse to omit a physical receipt from the check.
  if (driver.select("SELECT request_id FROM sys.production_request_receipts WHERE response_json IS NOT NULL AND NOT json_valid(response_json) LIMIT 1").length) throw unavailable();
  if (driver.select(`SELECT receipt.request_id FROM sys.production_request_receipts AS receipt
    WHERE EXISTS (SELECT 1 FROM json_tree(receipt.response_json) AS property
      WHERE property.key IN ('ownerPrivateKey','ownerToken','submitToken')) LIMIT 1`).length) throw unavailable();
}
