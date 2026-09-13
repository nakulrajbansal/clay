import { expect, it } from "vitest";
import { PostgresIntakeRelayStore, type IntakeRelayPgPool, type IntakeRelayRegistrationRecord } from "../src/intake-relay";

const at = Date.parse("2026-09-13T12:00:00.000Z");
const record: IntakeRelayRegistrationRecord = { formId: `form_${"a".repeat(26)}`, ownerTokenSha256: "1".repeat(64), submitTokenSha256: "2".repeat(64),
  publisherIdSha256: "3".repeat(64), sourceSha256: "4".repeat(64), expiresAt: "2026-09-20T12:00:00.000Z", maxCiphertextBytes: 4096 };

/** Owned SQL protocol fixture. Exercises the actual adapter's transactions and
 * restart paths; not a PostgreSQL service or physical durability certificate. */
function poolFixture() {
  let rows = new Map<string, Record<string, unknown>>(); let tail = Promise.resolve();
  const faults = { loseCommit: false, abortCommit: false, onLock: () => {} };
  const pool: IntakeRelayPgPool = { query: async () => ({ rows: [] }), connect: async () => {
    let staged = new Map<string, Record<string, unknown>>(); let unlock: (() => void) | null = null;
    return { release() { unlock?.(); }, query: async (sql: string, params: unknown[] = []) => {
      if (sql === "BEGIN") return { rows: [] };
      if (/pg_advisory_xact_lock/.test(sql)) {
        const previous = tail; tail = new Promise<void>(resolve => { unlock = resolve; }); await previous;
        faults.onLock(); staged = new Map([...rows].map(([key, value]) => [key, structuredClone(value)])); return { rows: [] };
      }
      if (sql === "ROLLBACK") return { rows: [] };
      if (sql === "COMMIT") {
        if (faults.abortCommit) { faults.abortCommit = false; throw new Error("Owned commit aborted"); }
        rows = staged;
        if (faults.loseCommit) { faults.loseCommit = false; throw new Error("Owned committed response lost"); }
        return { rows: [] };
      }
      if (/DELETE FROM intake_relay_forms/.test(sql)) {
        const deleted: Record<string, unknown>[] = [];
        for (const [id, row] of staged) if (Date.parse(String(row.expires_at)) <= Date.parse(String(params[0]))
            || (/revoked_at IS NOT NULL OR/.test(sql) && row.revoked_at !== null)) { staged.delete(id); deleted.push({ form_id: id }); }
        return { rows: deleted };
      }
      if (/DELETE FROM intake_relay_submissions|DELETE FROM intake_relay_registration_events|INSERT INTO intake_relay_registration_events/.test(sql)) return { rows: [] };
      if (/SELECT \* FROM intake_relay_forms/.test(sql)) { const row = staged.get(String(params[0])); return { rows: row ? [structuredClone(row)] : [] }; }
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ n: staged.size }] };
      if (/INSERT INTO intake_relay_forms/.test(sql)) {
        const fields = ["form_id", "owner_token_sha256", "submit_token_sha256", "publisher_id_sha256", "source_sha256", "expires_at", "max_ciphertext_bytes", "created_at", "revoked_at"];
        if (staged.has(String(params[0]))) throw new Error("Owned identity conflict");
        staged.set(String(params[0]), Object.fromEntries(fields.map((field, index) => [field, params[index] ?? null])));
        return { rows: [{ form_id: params[0] }] };
      }
      if (/UPDATE intake_relay_forms SET revoked_at/.test(sql)) {
        const row = staged.get(String(params[0])); if (!row || row.revoked_at !== null) return { rows: [] };
        row.revoked_at = params[1]; return { rows: [{ form_id: params[0] }] };
      }
      throw new Error("Unrecognized owned SQL protocol operation");
    } };
  } };
  return { pool, faults, count: () => rows.size };
}

it.each(["before_publication", "after_publication"])("keeps a %s tombstone through cleanup and adapter reopen", async when => {
  const fixture = poolFixture(), a = new PostgresIntakeRelayStore(fixture.pool, { now: () => at });
  if (when === "after_publication") await a.register(record);
  await a.terminalize(record); await a.cleanupExpired();
  const b = new PostgresIntakeRelayStore(fixture.pool, { now: () => at });
  await expect(b.register(record)).rejects.toMatchObject({ relayCode: "conflict" });
  await expect(b.terminalize(record)).resolves.toBeUndefined();
  await expect(b.terminalize({ ...record, submitTokenSha256: "5".repeat(64) })).rejects.toMatchObject({ relayCode: "conflict" });
  await expect(b.authorizeSubmission(record.formId, record.submitTokenSha256)).rejects.toMatchObject({ relayCode: "expired" });
  expect(fixture.count()).toBe(1);
});

it("does not admit a create whose pre-lock clock was fresh but whose serialized invocation is expired", async () => {
  const fixture = poolFixture(); let clock = at;
  fixture.faults.onLock = () => { clock = Date.parse(record.expiresAt); };
  const store = new PostgresIntakeRelayStore(fixture.pool, { now: () => clock });
  await expect(store.register(record)).rejects.toMatchObject({ relayCode: "invalid" });
  expect(fixture.count()).toBe(0); await expect(store.terminalize(record)).resolves.toBeUndefined();
});

it.each(["loseCommit", "abortCommit"] as const)("never reports a terminal acknowledgement for %s and resumes the exact identity", async fault => {
  const fixture = poolFixture(); fixture.faults[fault] = true;
  const a = new PostgresIntakeRelayStore(fixture.pool, { now: () => at });
  await expect(a.terminalize(record)).rejects.toThrow(/Owned/);
  expect(fixture.count()).toBe(fault === "loseCommit" ? 1 : 0);
  const b = new PostgresIntakeRelayStore(fixture.pool, { now: () => at });
  await b.terminalize(record); await b.cleanupExpired();
  await expect(b.register(record)).rejects.toMatchObject({ relayCode: "conflict" });
  expect(fixture.count()).toBe(1);
});
