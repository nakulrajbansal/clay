// Phase 1.2 (doc 07): magic-link auth, sessions, and quotas. Storage is
// injectable — MemoryAuthStore backs dev and tests; a Postgres adapter
// implements the same interface at deploy (the atomicity note on
// incrementUsage is the contract the adapter must honor).
//
// Privacy posture (doc 07 §2): account data plus bounded auth/rate authority
// metadata only. No intent text, no schema payloads, ever.

export type User = { id: string; email: string; plan: "free" | "pro" };
export type Usage = { used: number; periodStart: number };

export type MutationCallLimits = Readonly<{
  windowMs: number;
  maxPerUser: number;
  maxGlobal: number;
  maxConcurrentPerUser: number;
  maxConcurrentGlobal: number;
  leaseMs: number;
}>;

export const DEFAULT_MUTATION_CALL_LIMITS: MutationCallLimits = Object.freeze({
  windowMs: 60_000,
  maxPerUser: 60,
  maxGlobal: 240,
  maxConcurrentPerUser: 1,
  maxConcurrentGlobal: 8,
  leaseMs: 4 * 60_000,
});

export type RepairCapabilityBinding = Readonly<{
  userId: string;
  sessionDigest: string;
  contextDigest: string;
  planDigest: string;
}>;

export type MagicLinkLimits = Readonly<{
  windowMs: number;
  maxPerEmail: number;
  maxPerSource: number;
  maxGlobal: number;
}>;

export const DEFAULT_MAGIC_LINK_LIMITS: MagicLinkLimits = Object.freeze({
  windowMs: 60 * 60_000,
  maxPerEmail: 3,
  maxPerSource: 10,
  maxGlobal: 300,
});

export interface AuthStore {
  upsertUser(email: string): Promise<User>;
  getUser(id: string): Promise<User | null>;
  /** current rolling-30d usage row, creating/rolling as needed */
  usage(userId: string): Promise<Usage>;
  /** Atomically admit one metered attempt without ever crossing limit. */
  consumeUsage(userId: string, limit: number):
    Promise<{ allowed: boolean; usage: Usage }>;
  /** atomically increment and return the new count (legacy/admin path) */
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
  async consumeUsage(userId: string, limit: number):
    Promise<{ allowed: boolean; usage: Usage }> {
    const u = await this.usage(userId);
    if (u.used >= limit) return { allowed: false, usage: { ...u } };
    u.used += 1;
    return { allowed: true, usage: { ...u } };
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
  /** Atomically reserve all email/source/global slots and issue a token. */
  issueLink(email: string, sourceDigest: string, limits: MagicLinkLimits):
    Promise<string | null>;
  /** Consume a single-use token into its proven email (null = invalid/expired). */
  consumeLink(token: string): Promise<string | null>;
  /** Mint a session only after the application has created/found the proven user. */
  createSession(userId: string): Promise<string>;
  /** Remove an issued token if delivery fails. */
  discardLink(token: string): Promise<void>;
  /** resolve a session id to a user id, rolling the expiry */
  userIdFor(sid: string | undefined | null): Promise<string | null>;
  /** revoke a bearer/cookie session immediately */
  revoke(sid: string | undefined | null): Promise<void>;
  /** Atomically revoke every distinct credential presented by one logout. */
  revokeMany(sessionIds: readonly string[]): Promise<void>;
  /** Durably rate/concurrency-admit one provider call. */
  acquireMutationCall(userId: string, limits: MutationCallLimits): Promise<string | null>;
  /** Release a provider-call concurrency lease while retaining its rate record. */
  releaseMutationCall(leaseId: string): Promise<void>;
  /** Mint one short-lived repair capability after a plan response exists. */
  issueRepairCapability(binding: RepairCapabilityBinding): Promise<string>;
  /** Atomically consume the exact capability once. */
  consumeRepairCapability(token: string, binding: RepairCapabilityBinding): Promise<boolean>;
}

/** Magic-link tokens (15 min, single-use) and sessions (30d, rolling),
 * in memory: fine for containers; NOT for serverless (see SessionStore). */
export class Sessions implements SessionStore {
  private readonly links = new Map<string, { email: string; expires: number }>();
  private readonly sessions = new Map<string, { userId: string; expires: number }>();
  private readonly linkRate = new Map<string, number[]>();
  private readonly mutationCalls = new Map<string, {
    userId: string; startedAt: number; expiresAt: number; releasedAt: number | null;
  }>();
  private readonly repairCapabilities = new Map<string, RepairCapabilityBinding & {
    expiresAt: number; consumed: boolean;
  }>();

  async issueLink(
    email: string,
    sourceDigest: string,
    limits: MagicLinkLimits,
  ): Promise<string | null> {
    const now = Date.now();
    for (const [token, link] of this.links)
      if (link.expires <= now) this.links.delete(token);
    const scopes: [string, number][] = [
      [`email:${email}`, limits.maxPerEmail],
      [`source:${sourceDigest}`, limits.maxPerSource],
      ["global", limits.maxGlobal],
    ];
    const recent = scopes.map(([scope, max]) => ({
      scope, max,
      attempts: (this.linkRate.get(scope) ?? [])
        .filter(at => at > now - limits.windowMs),
    }));
    if (recent.some(entry => entry.attempts.length >= entry.max)) return null;
    for (const entry of recent) {
      entry.attempts.push(now);
      this.linkRate.set(entry.scope, entry.attempts);
    }
    const token = rand();
    this.links.set(token, { email, expires: now + 15 * 60_000 });
    return token;
  }

  async consumeLink(token: string): Promise<string | null> {
    const link = this.links.get(token);
    this.links.delete(token);                     // single-use
    if (!link || link.expires < Date.now()) return null;
    return link.email;
  }

  async createSession(userId: string): Promise<string> {
    const sid = rand();
    this.sessions.set(sid, { userId, expires: Date.now() + PERIOD_MS });
    return sid;
  }

  async discardLink(token: string): Promise<void> { this.links.delete(token); }

  async userIdFor(sid: string | undefined | null): Promise<string | null> {
    if (!sid) return null;
    const s = this.sessions.get(sid);
    if (!s || s.expires < Date.now()) return null;
    s.expires = Date.now() + PERIOD_MS;           // rolling
    return s.userId;
  }

  async revoke(sid: string | undefined | null): Promise<void> {
    await this.revokeMany(sid ? [sid] : []);
  }

  async revokeMany(sessionIds: readonly string[]): Promise<void> {
    for (const sid of new Set(sessionIds)) this.sessions.delete(sid);
  }

  async acquireMutationCall(userId: string, limits: MutationCallLimits): Promise<string | null> {
    const now = Date.now();
    for (const [id, call] of this.mutationCalls) {
      if (call.startedAt <= now - limits.windowMs && call.expiresAt <= now)
        this.mutationCalls.delete(id);
    }
    const recent = [...this.mutationCalls.values()]
      .filter(call => call.startedAt > now - limits.windowMs);
    const active = recent.filter(call => call.releasedAt === null && call.expiresAt > now);
    if (recent.length >= limits.maxGlobal
        || recent.filter(call => call.userId === userId).length >= limits.maxPerUser
        || active.length >= limits.maxConcurrentGlobal
        || active.filter(call => call.userId === userId).length >= limits.maxConcurrentPerUser)
      return null;
    const leaseId = rand();
    this.mutationCalls.set(leaseId, {
      userId, startedAt: now, expiresAt: now + limits.leaseMs, releasedAt: null,
    });
    return leaseId;
  }

  async releaseMutationCall(leaseId: string): Promise<void> {
    const call = this.mutationCalls.get(leaseId);
    if (call && call.releasedAt === null) call.releasedAt = Date.now();
  }

  async issueRepairCapability(binding: RepairCapabilityBinding): Promise<string> {
    const now = Date.now();
    for (const [token, capability] of this.repairCapabilities) {
      if (capability.expiresAt <= now || capability.consumed)
        this.repairCapabilities.delete(token);
    }
    const token = rand();
    this.repairCapabilities.set(token, {
      ...binding, expiresAt: now + 15 * 60_000, consumed: false,
    });
    return token;
  }

  async consumeRepairCapability(
    token: string,
    binding: RepairCapabilityBinding,
  ): Promise<boolean> {
    const capability = this.repairCapabilities.get(token);
    if (!capability || capability.consumed || capability.expiresAt <= Date.now()
        || capability.userId !== binding.userId
        || capability.sessionDigest !== binding.sessionDigest
        || capability.contextDigest !== binding.contextDigest
        || capability.planDigest !== binding.planDigest) return false;
    capability.consumed = true;
    return true;
  }
}
