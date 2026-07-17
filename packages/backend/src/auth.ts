// Phase 1.2 (doc 07): magic-link auth, sessions, and quotas. Storage is
// injectable — MemoryAuthStore backs dev and tests; a Postgres adapter
// implements the same interface at deploy (the atomicity note on
// incrementUsage is the contract the adapter must honor).
//
// Privacy posture (doc 07 §2): users(id, email, plan) and usage counters
// only. No intent text, no schema payloads, ever.

export type User = { id: string; email: string; plan: "free" | "pro" };
export type Usage = { used: number; periodStart: number };

export interface AuthStore {
  upsertUser(email: string): Promise<User>;
  getUser(id: string): Promise<User | null>;
  /** current rolling-30d usage row, creating/rolling as needed */
  usage(userId: string): Promise<Usage>;
  /** atomically increment and return the new count (Postgres: single
   * UPDATE ... RETURNING; memory impl is trivially atomic) */
  incrementUsage(userId: string): Promise<number>;
}

const PERIOD_MS = 30 * 86_400_000;
export const FREE_QUOTA = 20;

const rand = (): string =>
  [...crypto.getRandomValues(new Uint8Array(24))]
    .map(b => b.toString(16).padStart(2, "0")).join("");

export class MemoryAuthStore implements AuthStore {
  private readonly users = new Map<string, User>();
  private readonly byEmail = new Map<string, string>();
  private readonly usageRows = new Map<string, Usage>();

  async upsertUser(email: string): Promise<User> {
    const key = email.trim().toLowerCase();
    const existing = this.byEmail.get(key);
    if (existing) return this.users.get(existing)!;
    const user: User = { id: rand(), email: key, plan: "free" };
    this.users.set(user.id, user);
    this.byEmail.set(key, user.id);
    return user;
  }
  async getUser(id: string): Promise<User | null> { return this.users.get(id) ?? null; }
  async usage(userId: string): Promise<Usage> {
    let u = this.usageRows.get(userId);
    if (!u || Date.now() - u.periodStart > PERIOD_MS) {
      u = { used: 0, periodStart: Date.now() };
      this.usageRows.set(userId, u);
    }
    return u;
  }
  async incrementUsage(userId: string): Promise<number> {
    const u = await this.usage(userId);
    u.used += 1;
    return u.used;
  }
}

/** Session state interface. The memory impl below suits long-running
 * containers (Fly); serverless platforms (Vercel) MUST use the Postgres
 * impl (pg-store.ts) — every request may hit a fresh instance, so
 * in-memory tokens/sessions would evaporate between calls. */
export interface SessionStore {
  /** issue a magic token, or null when the address is over 3/hour */
  issueLink(user: User): Promise<string | null>;
  /** redeem a single-use token into a session id (null = invalid/expired) */
  redeem(token: string): Promise<string | null>;
  /** resolve a session id to a user id, rolling the expiry */
  userIdFor(sid: string | undefined | null): Promise<string | null>;
}

/** Magic-link tokens (15 min, single-use) and sessions (30d, rolling),
 * in memory: fine for containers; NOT for serverless (see SessionStore). */
export class Sessions implements SessionStore {
  private readonly links = new Map<string, { userId: string; expires: number }>();
  private readonly sessions = new Map<string, { userId: string; expires: number }>();
  private readonly linkRate = new Map<string, number[]>();

  /** Returns the token, or null when the address is over the 3/hour rate. */
  async issueLink(user: User): Promise<string | null> {
    const now = Date.now();
    const recent = (this.linkRate.get(user.email) ?? []).filter(t => now - t < 3_600_000);
    if (recent.length >= 3) return null;
    recent.push(now);
    this.linkRate.set(user.email, recent);
    const token = rand();
    this.links.set(token, { userId: user.id, expires: now + 15 * 60_000 });
    return token;
  }

  async redeem(token: string): Promise<string | null> {
    const link = this.links.get(token);
    this.links.delete(token);                     // single-use
    if (!link || link.expires < Date.now()) return null;
    const sid = rand();
    this.sessions.set(sid, { userId: link.userId, expires: Date.now() + PERIOD_MS });
    return sid;
  }

  async userIdFor(sid: string | undefined | null): Promise<string | null> {
    if (!sid) return null;
    const s = this.sessions.get(sid);
    if (!s || s.expires < Date.now()) return null;
    s.expires = Date.now() + PERIOD_MS;           // rolling
    return s.userId;
  }
}
