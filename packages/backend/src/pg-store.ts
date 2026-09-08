// Postgres AuthStore (doc 07 §2): the deploy-time adapter behind the same
// interface MemoryAuthStore implements. It retains accounts, usage, and
// bounded security authority metadata — never intent text, schema payloads,
// or raw source addresses (doc 06 §1: don't retain what isn't required).
import pg from "pg";
import { createHash } from "node:crypto";
import type {
  AuthStore, MagicLinkLimits, MutationCallLimits, RepairCapabilityBinding,
  SessionStore, Usage, User,
} from "./auth";
import { SHARE_RELAY_SCHEMA_SQL } from "./share-pg-store";

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS usage (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  period_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  mutations_used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS login_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  email TEXT NOT NULL,
  expires TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires TIMESTAMPTZ NOT NULL
);
ALTER TABLE login_tokens ALTER COLUMN user_id DROP NOT NULL;
CREATE TABLE IF NOT EXISTS magic_link_issuances (
  id TEXT PRIMARY KEY,
  email_digest TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS magic_link_issuances_created_idx
  ON magic_link_issuances(created_at);
CREATE INDEX IF NOT EXISTS magic_link_issuances_email_created_idx
  ON magic_link_issuances(email_digest, created_at);
CREATE INDEX IF NOT EXISTS magic_link_issuances_source_created_idx
  ON magic_link_issuances(source_digest, created_at);
CREATE TABLE IF NOT EXISTS mutation_calls (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_expires TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS mutation_calls_started_idx
  ON mutation_calls(started_at);
CREATE INDEX IF NOT EXISTS mutation_calls_user_started_idx
  ON mutation_calls(user_id, started_at);
CREATE TABLE IF NOT EXISTS repair_capabilities (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_digest TEXT NOT NULL,
  context_digest TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  expires TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);
${SHARE_RELAY_SCHEMA_SQL.trim()}`;

const PERIOD_MS = 30 * 86_400_000;
const rand = (): string =>
  [...crypto.getRandomValues(new Uint8Array(24))]
    .map(b => b.toString(16).padStart(2, "0")).join("");

/** Minimal query surface so tests can inject a fake pool. */
export type QueryableClient = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
};

export type Queryable = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  connect?: () => Promise<QueryableClient>;
};

export class PostgresAuthStore implements AuthStore {
  constructor(private readonly pool: Queryable) {}

  /** shared pool for PgSessions (one connection budget, doc 07 thinness) */
  get db(): Queryable { return this.pool; }

  static connect(databaseUrl: string): PostgresAuthStore {
    return new PostgresAuthStore(new pg.Pool({ connectionString: databaseUrl }));
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
  }

  async upsertUser(email: string): Promise<User> {
    const key = email.trim().toLowerCase();
    const found = await this.pool.query(
      "SELECT id, email, plan FROM users WHERE email = $1", [key]);
    if (found.rows[0]) return found.rows[0] as User;
    const id = rand();
    await this.pool.query(
      "INSERT INTO users(id, email) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING",
      [id, key]);
    const row = await this.pool.query(
      "SELECT id, email, plan FROM users WHERE email = $1", [key]);
    return row.rows[0] as User;
  }

  async getUser(id: string): Promise<User | null> {
    const r = await this.pool.query(
      "SELECT id, email, plan FROM users WHERE id = $1", [id]);
    return (r.rows[0] as User) ?? null;
  }

  async usage(userId: string): Promise<Usage> {
    await this.pool.query(
      `INSERT INTO usage(user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
    // roll the window when it lapsed
    await this.pool.query(
      `UPDATE usage SET period_start = now(), mutations_used = 0
       WHERE user_id = $1 AND period_start < now() - interval '30 days'`, [userId]);
    const r = await this.pool.query(
      "SELECT period_start, mutations_used FROM usage WHERE user_id = $1", [userId]);
    const row = r.rows[0]!;
    return { used: Number(row.mutations_used),
      periodStart: new Date(String(row.period_start)).getTime() };
  }

  async consumeUsage(userId: string, limit: number):
    Promise<{ allowed: boolean; usage: Usage }> {
    await this.pool.query(
      `INSERT INTO usage(user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
    const consumed = await this.pool.query(
      `UPDATE usage SET
         period_start = CASE
           WHEN period_start < now() - interval '30 days' THEN now()
           ELSE period_start END,
         mutations_used = CASE
           WHEN period_start < now() - interval '30 days' THEN 1
           ELSE mutations_used + 1 END
       WHERE user_id = $1
         AND (period_start < now() - interval '30 days' OR mutations_used < $2)
       RETURNING period_start, mutations_used`, [userId, limit]);
    const row = consumed.rows[0];
    if (row) return { allowed: true, usage: {
      used: Number(row.mutations_used),
      periodStart: new Date(String(row.period_start)).getTime(),
    } };
    return { allowed: false, usage: await this.usage(userId) };
  }

  async incrementUsage(userId: string): Promise<number> {
    await this.usage(userId);   // ensure row + rolled window
    const r = await this.pool.query(
      `UPDATE usage SET mutations_used = mutations_used + 1
       WHERE user_id = $1 RETURNING mutations_used`, [userId]);
    return Number(r.rows[0]!.mutations_used);
  }
}
void PERIOD_MS;

/** Durable sessions for serverless (Vercel): every request may hit a
 * fresh instance, so tokens/sessions/rate-limits live in Postgres. */
export class PgSessions implements SessionStore {
  constructor(private readonly pool: Queryable) {}

  private async admissionTransaction<T>(
    lockId: number,
    run: (client: QueryableClient) => Promise<T>,
  ): Promise<T> {
    if (!this.pool.connect)
      throw new Error("transactional database admission is unavailable");
    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      began = true;
      await client.query("SELECT pg_advisory_xact_lock($1)", [lockId]);
      const result = await run(client);
      await client.query("COMMIT");
      began = false;
      return result;
    } catch (error) {
      if (began) {
        try { await client.query("ROLLBACK"); } catch { /* preserve the admission failure */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async issueLink(
    email: string,
    sourceDigest: string,
    limits: MagicLinkLimits,
  ): Promise<string | null> {
    const token = rand();
    const issuanceId = rand();
    const emailDigest = createHash("sha256").update(email, "utf8").digest("hex");
    const admitted = await this.admissionTransaction(2026090802, client => client.query(
      `WITH purged_tokens AS (
         DELETE FROM login_tokens WHERE expires <= now()
       ), purged_issuances AS (
         DELETE FROM magic_link_issuances
          WHERE created_at <= now() - ($4 * interval '1 millisecond')
       ), counts AS (
         SELECT COUNT(*) AS global_recent,
           COUNT(*) FILTER (WHERE email_digest = $9) AS email_recent,
           COUNT(*) FILTER (WHERE source_digest = $3) AS source_recent
         FROM magic_link_issuances
          WHERE created_at > now() - ($4 * interval '1 millisecond')
       ), issuance AS (
         INSERT INTO magic_link_issuances(id, email_digest, source_digest)
         SELECT $5, $9, $3 FROM counts
          WHERE email_recent < $6 AND source_recent < $7 AND global_recent < $8
         RETURNING id
       )
       INSERT INTO login_tokens(token, email, expires)
       SELECT $1, $2, now() + interval '15 minutes' FROM issuance
       RETURNING token`,
      [token, email, sourceDigest, limits.windowMs, issuanceId,
        limits.maxPerEmail, limits.maxPerSource, limits.maxGlobal, emailDigest],
    ));
    return admitted.rows[0] ? token : null;
  }

  async consumeLink(token: string): Promise<string | null> {
    const r = await this.pool.query(
      `DELETE FROM login_tokens WHERE token = $1 AND used = false
       RETURNING email, (expires > now()) AS live`, [token]);
    const row = r.rows[0];
    if (!row || !row.live) return null;
    return String(row.email);
  }

  async createSession(userId: string): Promise<string> {
    const sid = rand();
    await this.pool.query(
      `INSERT INTO sessions(id, user_id, expires)
       VALUES ($1, $2, now() + interval '30 days')`, [sid, userId]);
    return sid;
  }

  async discardLink(token: string): Promise<void> {
    await this.pool.query("DELETE FROM login_tokens WHERE token = $1", [token]);
  }

  async userIdFor(sid: string | undefined | null): Promise<string | null> {
    if (!sid) return null;
    const r = await this.pool.query(
      `UPDATE sessions SET expires = now() + interval '30 days'
       WHERE id = $1 AND expires > now() RETURNING user_id`, [sid]);
    return r.rows[0] ? String(r.rows[0].user_id) : null;
  }

  async revoke(sid: string | undefined | null): Promise<void> {
    await this.revokeMany(sid ? [sid] : []);
  }

  async revokeMany(sessionIds: readonly string[]): Promise<void> {
    const distinct = [...new Set(sessionIds.filter(Boolean))];
    if (distinct.length > 0)
      await this.pool.query("DELETE FROM sessions WHERE id = ANY($1::text[])", [distinct]);
  }

  async acquireMutationCall(userId: string, limits: MutationCallLimits): Promise<string | null> {
    const leaseId = rand();
    // A dedicated transaction acquires its advisory lock before the
    // count-and-insert statement obtains a fresh READ COMMITTED snapshot.
    // Provider work starts only after COMMIT releases this short lock.
    const admitted = await this.admissionTransaction(2026090801, client => client.query(
      `WITH purged AS (
         DELETE FROM mutation_calls
          WHERE started_at <= now() - ($3 * interval '1 millisecond')
            AND (released_at IS NOT NULL OR lease_expires <= now())
       ), counts AS (
         SELECT
           COUNT(*) FILTER (WHERE started_at > now() - ($3 * interval '1 millisecond'))
             AS global_recent,
           COUNT(*) FILTER (WHERE user_id = $2
             AND started_at > now() - ($3 * interval '1 millisecond')) AS user_recent,
           COUNT(*) FILTER (WHERE released_at IS NULL AND lease_expires > now())
             AS global_active,
           COUNT(*) FILTER (WHERE user_id = $2
             AND released_at IS NULL AND lease_expires > now()) AS user_active
         FROM mutation_calls
       )
       INSERT INTO mutation_calls(id, user_id, lease_expires)
       SELECT $1, $2, now() + ($4 * interval '1 millisecond') FROM counts
        WHERE global_recent < $6 AND user_recent < $5
          AND global_active < $8 AND user_active < $7
       RETURNING id`,
      [leaseId, userId, limits.windowMs, limits.leaseMs,
        limits.maxPerUser, limits.maxGlobal,
        limits.maxConcurrentPerUser, limits.maxConcurrentGlobal],
    ));
    return admitted.rows[0] ? leaseId : null;
  }

  async releaseMutationCall(leaseId: string): Promise<void> {
    await this.pool.query(
      `UPDATE mutation_calls SET released_at = COALESCE(released_at, now()) WHERE id = $1`,
      [leaseId],
    );
  }

  async issueRepairCapability(binding: RepairCapabilityBinding): Promise<string> {
    const token = rand();
    await this.pool.query(
      `WITH purged AS (
         DELETE FROM repair_capabilities WHERE expires <= now() OR consumed_at IS NOT NULL
       )
       INSERT INTO repair_capabilities(
         token, user_id, session_digest, context_digest, plan_digest, expires
       ) VALUES ($1, $2, $3, $4, $5, now() + interval '15 minutes')`,
      [token, binding.userId, binding.sessionDigest,
        binding.contextDigest, binding.planDigest],
    );
    return token;
  }

  async consumeRepairCapability(
    token: string,
    binding: RepairCapabilityBinding,
  ): Promise<boolean> {
    const consumed = await this.pool.query(
      `UPDATE repair_capabilities SET consumed_at = now()
        WHERE token = $1 AND user_id = $2 AND session_digest = $3
          AND context_digest = $4 AND plan_digest = $5
          AND expires > now() AND consumed_at IS NULL
       RETURNING token`,
      [token, binding.userId, binding.sessionDigest,
        binding.contextDigest, binding.planDigest],
    );
    return Boolean(consumed.rows[0]);
  }
}
