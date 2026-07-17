// Postgres AuthStore (doc 07 §2): the deploy-time adapter behind the same
// interface MemoryAuthStore implements. Only accounts and usage counters
// live here — never intent text, never schema payloads (design commitment,
// doc 06 §1: a curious operator can't read what isn't retained).
import pg from "pg";
import type { AuthStore, Usage, User } from "./auth";

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
