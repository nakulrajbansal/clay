// Postgres AuthStore (doc 07 §2): the deploy-time adapter behind the same
// interface MemoryAuthStore implements. Only accounts and usage counters
// live here — never intent text, never schema payloads (design commitment,
// doc 06 §1: a curious operator can't read what isn't retained).
import pg from "pg";
import type { AuthStore, SessionStore, Usage, User } from "./auth";

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
  user_id TEXT NOT NULL REFERENCES users(id),
  email TEXT NOT NULL,
  expires TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires TIMESTAMPTZ NOT NULL
);`;

const PERIOD_MS = 30 * 86_400_000;
const rand = (): string =>
  [...crypto.getRandomValues(new Uint8Array(24))]
    .map(b => b.toString(16).padStart(2, "0")).join("");

/** Minimal query surface so tests can inject a fake pool. */
export type Queryable = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
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

  async issueLink(user: User): Promise<string | null> {
    const recent = await this.pool.query(
      `SELECT COUNT(*) AS n FROM login_tokens
       WHERE email = $1 AND created_at > now() - interval '1 hour'`, [user.email]);
    if (Number(recent.rows[0]!.n) >= 3) return null;
    const token = rand();
    await this.pool.query(
      `INSERT INTO login_tokens(token, user_id, email, expires)
       VALUES ($1, $2, $3, now() + interval '15 minutes')`,
      [token, user.id, user.email]);
    return token;
  }

  async redeem(token: string): Promise<string | null> {
    // mark-used (not delete) so a redeemed link still counts toward the
    // 3/hour rate limit, matching the in-memory Sessions semantics; the
    // conditional UPDATE wins single-use races atomically
    const r = await this.pool.query(
      `UPDATE login_tokens SET used = true
       WHERE token = $1 AND used = false RETURNING user_id,
        (expires > now()) AS live`, [token]);
    const row = r.rows[0];
    if (!row || !row.live) return null;
    const sid = rand();
    await this.pool.query(
      `INSERT INTO sessions(id, user_id, expires)
       VALUES ($1, $2, now() + interval '30 days')`, [sid, String(row.user_id)]);
    return sid;
  }

  async userIdFor(sid: string | undefined | null): Promise<string | null> {
    if (!sid) return null;
    const r = await this.pool.query(
      `UPDATE sessions SET expires = now() + interval '30 days'
       WHERE id = $1 AND expires > now() RETURNING user_id`, [sid]);
    return r.rows[0] ? String(r.rows[0].user_id) : null;
  }
}
