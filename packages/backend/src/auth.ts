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
  upsertUser(email: string): User;
  getUser(id: string): User | null;
  /** current rolling-30d usage row, creating/rolling as needed */
  usage(userId: string): Usage;
  /** atomically increment and return the new count (Postgres: single
   * UPDATE ... RETURNING; memory impl is trivially atomic) */
  incrementUsage(userId: string): number;
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

  upsertUser(email: string): User {
    const key = email.trim().toLowerCase();
    const existing = this.byEmail.get(key);
    if (existing) return this.users.get(existing)!;
    const user: User = { id: rand(), email: key, plan: "free" };
    this.users.set(user.id, user);
    this.byEmail.set(key, user.id);
    return user;
  }
  getUser(id: string): User | null { return this.users.get(id) ?? null; }
  usage(userId: string): Usage {
    let u = this.usageRows.get(userId);
    if (!u || Date.now() - u.periodStart > PERIOD_MS) {
      u = { used: 0, periodStart: Date.now() };
      this.usageRows.set(userId, u);
    }
    return u;
  }
  incrementUsage(userId: string): number {
    const u = this.usage(userId);
    u.used += 1;
    return u.used;
  }
}

/** Magic-link tokens (15 min, single-use) and sessions (30d, rolling),
 * both in memory by design: a restart logs users out, it never loses data
 * (accounts re-link by email; app data lives client-side). */
export class Sessions {
  private readonly links = new Map<string, { userId: string; expires: number }>();
  private readonly sessions = new Map<string, { userId: string; expires: number }>();
  private readonly linkRate = new Map<string, number[]>();

  /** Returns the token, or null when the address is over the 3/hour rate. */
  issueLink(user: User): string | null {
    const now = Date.now();
    const recent = (this.linkRate.get(user.email) ?? []).filter(t => now - t < 3_600_000);
    if (recent.length >= 3) return null;
    recent.push(now);
    this.linkRate.set(user.email, recent);
    const token = rand();
    this.links.set(token, { userId: user.id, expires: now + 15 * 60_000 });
    return token;
  }

  redeem(token: string): string | null {
    const link = this.links.get(token);
    this.links.delete(token);                     // single-use
    if (!link || link.expires < Date.now()) return null;
    const sid = rand();
    this.sessions.set(sid, { userId: link.userId, expires: Date.now() + PERIOD_MS });
    return sid;
  }

  userIdFor(sid: string | undefined | null): string | null {
    if (!sid) return null;
    const s = this.sessions.get(sid);
    if (!s || s.expires < Date.now()) return null;
    s.expires = Date.now() + PERIOD_MS;           // rolling
    return s.userId;
  }
}
