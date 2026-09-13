import type { Queryable } from "./pg-store";
import type {
  ShareRelayCreateResultV1, ShareRelayLookupV1, ShareRelayRecordV1,
  ShareRelayRevokeResultV1, ShareRelayStore,
  ShareRelayTerminalResultV1,
} from "./share-store";
import { sameShareIdentity } from "./share-store";

export const SHARE_RELAY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY CHECK (id ~ '^shr_[a-z2-7]{26}$'),
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  revoke_token_hash TEXT NOT NULL CHECK (length(revoke_token_hash) = 43),
  ciphertext_bytes INTEGER NOT NULL
    CHECK (ciphertext_bytes BETWEEN 16 AND 8388624),
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + interval '30 days')
);
CREATE INDEX IF NOT EXISTS share_links_expiry_idx ON share_links(expires_at);`;

function iso(value: unknown): string {
  const parsed = new Date(value instanceof Date ? value.getTime() : String(value));
  if (!Number.isFinite(parsed.getTime())) throw new Error("invalid share relay timestamp");
  return parsed.toISOString();
}

function recordFromRow(row: Record<string, unknown>): ShareRelayRecordV1 {
  return {
    shareId: String(row.id),
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
    ownerId: row.owner_id === null || row.owner_id === undefined ? null : String(row.owner_id),
    revokeTokenHash: String(row.revoke_token_hash),
    envelope: {
      schema: 1,
      algorithm: "A256GCM",
      iv: String(row.iv),
      ciphertext: String(row.ciphertext),
    },
    ciphertextBytes: Number(row.ciphertext_bytes),
    ...(row.revoked_at === null || row.revoked_at === undefined
      ? {} : { revokedAt: iso(row.revoked_at) }),
  };
}

const SELECT_SHARE = `SELECT id, ciphertext, iv, expires_at, created_at, owner_id,
  revoke_token_hash, ciphertext_bytes, revoked_at
 FROM share_links WHERE id = $1`;

type ShareTransactionClientV1 = Queryable & { release(): void };
type ShareTransactionalPoolV1 = Queryable & {
  connect?: () => Promise<ShareTransactionClientV1>;
};

export class PostgresShareRelayStore implements ShareRelayStore {
  constructor(private readonly pool: ShareTransactionalPoolV1) {}

  async create(record: ShareRelayRecordV1, clock: () => number): Promise<ShareRelayCreateResultV1> {
    return this.allocate(structuredClone(record), clock, false);
  }

  async terminalize(record: ShareRelayRecordV1, clock: () => number): Promise<ShareRelayTerminalResultV1> {
    const result = await this.allocate(structuredClone(record), clock, true);
    return result === "conflict" || result === "capacity" ? result : "terminal";
  }

  private async allocate(record: ShareRelayRecordV1, clock: () => number, terminal: boolean): Promise<ShareRelayCreateResultV1> {
    if (!this.pool.connect)
      throw new Error("Postgres share relay requires a transaction-capable pool");
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      // Both absent-ID terminalization and creation share one serialization
      // point, including cross-owner identity conflicts. A tombstone is never
      // briefly installed as a public link.
      await client.query("SELECT pg_advisory_xact_lock(1129072973)");
      // A transaction-scoped owner lock serializes the subsequent fresh-snapshot
      // quota check. A single-statement advisory-lock CTE would retain a stale
      // snapshot after waiting and is deliberately not used.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [record.ownerId ?? "anonymous"],
      );
      const now = clock();
      if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid share relay clock");
      const at = new Date(now).toISOString();
      // Expired rows are reclaimed under the same owner lock. Revocation
      // tombstones remain until expiry so an opaque id cannot be reused.
      await client.query(
        `DELETE FROM share_links
         WHERE expires_at <= $1 AND owner_id IS NOT DISTINCT FROM $2`,
        [at, record.ownerId],
      );
      let outcome: ShareRelayCreateResultV1;
      const prior = (await client.query(SELECT_SHARE + " FOR UPDATE", [record.shareId])).rows[0];
      if (prior) {
        const existing = recordFromRow(prior);
        if (!sameShareIdentity(existing, record) || (!terminal && existing.revokedAt !== undefined)) outcome = "conflict";
        else {
          if (terminal && existing.revokedAt === undefined) await client.query(
            `UPDATE share_links SET revoked_at = $3 WHERE id = $1 AND revoke_token_hash = $2
             AND revoked_at IS NULL RETURNING id`, [record.shareId, record.revokeTokenHash, at]);
          outcome = "replayed";
        }
      } else if (Date.parse(record.expiresAt) <= now) outcome = "expired";
      else {
      const inserted = await client.query(
        `INSERT INTO share_links(
           id, ciphertext, iv, expires_at, created_at, owner_id,
           revoke_token_hash, ciphertext_bytes, revoked_at)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
         WHERE (SELECT COUNT(*) FROM share_links
                WHERE owner_id IS NOT DISTINCT FROM $6
                  AND expires_at > $5) < 100
           AND (SELECT COALESCE(SUM(ciphertext_bytes), 0) FROM share_links
                WHERE owner_id IS NOT DISTINCT FROM $6
                  AND expires_at > $5) + $8 <= 67108864
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [record.shareId, record.envelope.ciphertext, record.envelope.iv,
          record.expiresAt, record.createdAt, record.ownerId,
          record.revokeTokenHash, record.ciphertextBytes, terminal ? at : null],
      );
      outcome = "created";
      if (!inserted.rows[0]) {
        const existing = await client.query(
          "SELECT id FROM share_links WHERE id = $1", [record.shareId]);
        outcome = existing.rows[0] ? "conflict" : "capacity";
      }
      }
      await client.query("COMMIT");
      transactionOpen = false;
      return outcome;
    } catch (error) {
      if (transactionOpen) {
        try { await client.query("ROLLBACK"); } catch { /* preserve the cause */ }
      }
      throw error;
    } finally { client.release(); }
  }

  async lookup(shareId: string, now: number): Promise<ShareRelayLookupV1> {
    const result = await this.pool.query(SELECT_SHARE, [shareId]);
    if (!result.rows[0]) return { state: "not_found" };
    const record = recordFromRow(result.rows[0]);
    if (record.revokedAt !== undefined) return { state: "revoked" };
    if (Date.parse(record.expiresAt) <= now) return { state: "expired" };
    return { state: "active", record };
  }

  async revoke(
    shareId: string, candidateTokenHash: string, now: number,
  ): Promise<ShareRelayRevokeResultV1> {
    const at = new Date(now).toISOString();
    const updated = await this.pool.query(
      `UPDATE share_links SET revoked_at = $3
       WHERE id = $1 AND revoke_token_hash = $2 AND revoked_at IS NULL
         AND expires_at > $3
       RETURNING id`,
      [shareId, candidateTokenHash, at],
    );
    if (updated.rows[0]) return "revoked";
    const state = await this.lookup(shareId, now);
    if (state.state === "not_found") return "not_found";
    if (state.state === "expired") return "expired";
    if (state.state === "revoked") return "revoked";
    return "forbidden";
  }
}
