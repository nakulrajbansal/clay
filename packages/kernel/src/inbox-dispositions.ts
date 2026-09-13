import { z } from "zod";
import { InboxDispositionV1 } from "@clay/schema/daily-home";
import type { DbDriver } from "./db";
import { ClayError } from "./errors";
import { resolveLocalDateTime } from "./daily-calendar";

export const INBOX_DISPOSITION_TABLE = "inbox_dispositions";
export const INBOX_DISPOSITION_SQL = `CREATE TABLE inbox_dispositions(
  source_key TEXT PRIMARY KEY, source_generation TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0), disposition_json TEXT NOT NULL)`;
const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim().toLowerCase();
const fail = (): never => { throw new ClayError("E_STATE_DIGEST_INVALID", "Inbox disposition storage is not a closed canonical table"); };
type Database = "main" | "sys";

/** Absence is the exact pre-ADR-054 schema, not permission to ignore an unknown
 * row or partial table. Creation happens only in an authority mutation. */
export function inboxDispositionTablePresent(driver: DbDriver, database: Database = "sys"): boolean {
  const objects = driver.select(`SELECT type,name,tbl_name,sql FROM ${database}.sqlite_master
    WHERE name = 'inbox_dispositions' OR tbl_name = 'inbox_dispositions' ORDER BY name`);
  if (!objects.length) return false;
  if (objects.length !== 2 || objects[0]?.name !== INBOX_DISPOSITION_TABLE || objects[0].type !== "table"
      || objects[0].tbl_name !== INBOX_DISPOSITION_TABLE || typeof objects[0].sql !== "string"
      || normalize(objects[0].sql) !== normalize(INBOX_DISPOSITION_SQL)
      || objects[1]?.name !== "sqlite_autoindex_inbox_dispositions_1" || objects[1].type !== "index" || objects[1].sql !== null) return fail();
  return true;
}
export function createInboxDispositionTable(driver: DbDriver, database: Database = "sys"): void {
  if (!inboxDispositionTablePresent(driver, database)) driver.exec(INBOX_DISPOSITION_SQL.replace("CREATE TABLE ", `CREATE TABLE ${database}.`));
  if (!inboxDispositionTablePresent(driver, database)) fail();
}
export function readInboxDispositions(driver: DbDriver, database: Database = "sys"): InboxDispositionV1[] {
  if (!inboxDispositionTablePresent(driver, database)) return [];
  const rows = driver.select(`SELECT source_key,source_generation,revision,disposition_json FROM ${database}.inbox_dispositions ORDER BY source_key LIMIT 10001`);
  const count = driver.select(`SELECT count(*) AS n FROM ${database}.inbox_dispositions`)[0]?.n;
  if (rows.length > 10000 || count !== rows.length) return fail();
  const parsed = rows.map(row => {
    if (typeof row.disposition_json !== "string" || row.disposition_json.length > 2048) return fail();
    let value: InboxDispositionV1;
    try { value = InboxDispositionV1.parse(JSON.parse(row.disposition_json)); } catch { return fail(); }
    if (value.state === "snoozed" && resolveLocalDateTime(`${value.localDate}T00:00`, value.timeZone!).instant !== value.until) return fail();
    if (value.sourceKey !== row.source_key || value.sourceGeneration !== row.source_generation || value.revision !== row.revision) return fail();
    return value;
  });
  if (new Set(parsed.map(row => row.sourceKey)).size !== rows.length || new Set(parsed.map(row => row.revision)).size !== rows.length) return fail();
  return parsed;
}
export const InboxDispositionWriteV1 = z.object({ expectedRevision: z.number().int().nonnegative().safe(), value: InboxDispositionV1 }).strict();
export function writeInboxDisposition(driver: DbDriver, input: unknown): { disposition: InboxDispositionV1; previous: InboxDispositionV1 | null } {
  const { expectedRevision, value } = InboxDispositionWriteV1.parse(input);
  return driver.tx(() => {
    const rows = readInboxDispositions(driver);
    const previous = rows.find(row => row.sourceKey === value.sourceKey) ?? null;
    const revision = Math.max(0, ...rows.map(row => row.revision)) + 1;
    if ((previous?.revision ?? 0) !== expectedRevision || value.revision !== revision || !Number.isSafeInteger(revision)
        || (!previous && rows.length >= 10000)) throw new ClayError("E_CONFLICT", "Inbox disposition CAS or retained limit changed");
    createInboxDispositionTable(driver);
    driver.exec(`INSERT INTO sys.inbox_dispositions(source_key,source_generation,revision,disposition_json) VALUES(?,?,?,?)
      ON CONFLICT(source_key) DO UPDATE SET source_generation=excluded.source_generation,revision=excluded.revision,disposition_json=excluded.disposition_json`,
      [value.sourceKey, value.sourceGeneration, value.revision, JSON.stringify(value)]);
    const readback = readInboxDispositions(driver).find(row => row.sourceKey === value.sourceKey);
    if (JSON.stringify(readback) !== JSON.stringify(value)) return fail();
    return { disposition: value, previous };
  });
}
