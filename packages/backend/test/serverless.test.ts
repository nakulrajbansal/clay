// Serverless (Vercel) simulation: every request may hit a FRESH backend
// instance, so nothing auth-related may live in process memory. Each
// request below builds brand-new PostgresAuthStore + PgSessions objects
// sharing only a fake Postgres pool — sign-in on "instance A" must be
// visible to "instance B". The fake pool also pins the exact SQL shapes
// pg-store.ts emits, so a query rewrite that breaks semantics fails here.
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { PgSessions, PostgresAuthStore, SCHEMA_SQL } from "../src/pg-store";
import type { Queryable } from "../src/pg-store";
import { buildServerlessApp } from "../../../api/index";
import { FREE_QUOTA } from "../src/auth";
import type { MutationCallLimits, RepairCapabilityBinding } from "../src/auth";

const fakeClient = { rawPlan: async () => "{}", rawRepair: async () => "{}" };
const AUTH_STATE = "a".repeat(64);
const authBody = (email: string): string => JSON.stringify({ email, state: AUTH_STATE });

/** In-memory emulation of the exact statements pg-store.ts uses. */
function fakePool(): Queryable & {
  now: () => number; skew: number; tokenCount: () => number; userCount: () => number;
  seedUsedToken: (email: string) => string;
} {
  type Row = Record<string, unknown>;
  const users: Row[] = [];
  const usage = new Map<string, { period_start: number; mutations_used: number }>();
  const tokens = new Map<string, {
    user_id: string | null; email: string; expires: number; used: boolean; created_at: number;
  }>();
  const sessions = new Map<string, { user_id: string; expires: number }>();
  const linkIssuances = new Map<string, {
    email_digest: string; source_digest: string; created_at: number;
  }>();
  const mutationCalls = new Map<string, {
    user_id: string; started_at: number; lease_expires: number; released_at: number | null;
  }>();
  const repairCapabilities = new Map<string, {
    user_id: string; session_digest: string; context_digest: string;
    plan_digest: string; expires: number; consumed_at: number | null;
  }>();
  const pool = {
    skew: 0,
    now(): number { return Date.now() + this.skew; },
    tokenCount(): number { return tokens.size; },
    userCount(): number { return users.length; },
    seedUsedToken(email: string): string {
      const token = "used-token-from-the-previous-schema";
      tokens.set(token, {
        user_id: null, email, expires: this.now() + 15 * 60_000,
        used: true, created_at: this.now(),
      });
      return token;
    },
    async connect() {
      return {
        query: (sql: string, params?: unknown[]) => this.query(sql, params),
        release(): void {},
      };
    },
    async query(sql: string, params: unknown[] = []): Promise<{ rows: Row[] }> {
      const p = params.map(String);
      const now = this.now();
      if (/^(?:BEGIN(?: ISOLATION LEVEL READ COMMITTED)?|COMMIT|ROLLBACK)$/.test(sql.trim())
          || /SELECT pg_advisory_xact_lock/.test(sql)) return { rows: [] };
      if (sql === SCHEMA_SQL) return { rows: [] };
      if (/SELECT id, email, plan FROM users WHERE email/.test(sql))
        return { rows: users.filter(u => u.email === p[0]) };
      if (/SELECT id, email, plan FROM users WHERE id/.test(sql))
        return { rows: users.filter(u => u.id === p[0]) };
      if (/INSERT INTO users/.test(sql)) {
        if (!users.some(u => u.email === p[1]))
          users.push({ id: p[0], email: p[1], plan: "free" });
        return { rows: [] };
      }
      if (/INSERT INTO usage/.test(sql)) {
        if (!usage.has(p[0]!)) usage.set(p[0]!, { period_start: now, mutations_used: 0 });
        return { rows: [] };
      }
      if (/UPDATE usage SET period_start/.test(sql)) {
        const u = usage.get(p[0]!);
        if (u && u.period_start < now - 30 * 86_400_000)
          Object.assign(u, { period_start: now, mutations_used: 0 });
        return { rows: [] };
      }
      if (/mutations_used < \$2/.test(sql)) {
        const u = usage.get(p[0]!)!;
        if (u.period_start < now - 30 * 86_400_000)
          Object.assign(u, { period_start: now, mutations_used: 0 });
        if (u.mutations_used >= Number(p[1])) return { rows: [] };
        u.mutations_used += 1;
        return { rows: [{ period_start: new Date(u.period_start).toISOString(),
          mutations_used: u.mutations_used }] };
      }
      if (/SELECT period_start, mutations_used FROM usage/.test(sql)) {
        const u = usage.get(p[0]!)!;
        return { rows: [{ period_start: new Date(u.period_start).toISOString(),
          mutations_used: u.mutations_used }] };
      }
      if (/UPDATE usage SET mutations_used = mutations_used \+ 1/.test(sql)) {
        const u = usage.get(p[0]!)!;
        u.mutations_used += 1;
        return { rows: [{ mutations_used: u.mutations_used }] };
      }
      if (/SELECT COUNT\(\*\) AS n FROM login_tokens/.test(sql)) {
        const n = [...tokens.values()]
          .filter(t => t.email === p[0] && t.created_at > now - 3_600_000).length;
        return { rows: [{ n }] };
      }
      if (/INSERT INTO login_tokens/.test(sql) && /magic_link_issuances/.test(sql)) {
        const windowMs = Number(p[3]);
        for (const [token, record] of tokens)
          if (record.expires <= now) tokens.delete(token);
        for (const [id, record] of linkIssuances)
          if (record.created_at <= now - windowMs) linkIssuances.delete(id);
        const recent = [...linkIssuances.values()];
        if (recent.length >= Number(p[7])
            || recent.filter(record => record.email_digest === p[8]).length >= Number(p[5])
            || recent.filter(record => record.source_digest === p[2]).length >= Number(p[6]))
          return { rows: [] };
        linkIssuances.set(p[4]!, {
          email_digest: p[8]!, source_digest: p[2]!, created_at: now,
        });
        tokens.set(p[0]!, {
          user_id: null, email: p[1]!, expires: now + 15 * 60_000,
          used: false, created_at: now,
        });
        return { rows: [{ token: p[0] }] };
      }
      if (/INSERT INTO login_tokens/.test(sql)) {
        tokens.set(p[0]!, { user_id: p[1]!, email: p[2]!,
          expires: now + 15 * 60_000, used: false, created_at: now });
        return { rows: [] };
      }
      if (/UPDATE login_tokens SET used = true/.test(sql)) {
        const t = tokens.get(p[0]!);
        if (!t || t.used) return { rows: [] };
        t.used = true;
        return { rows: [{ user_id: t.user_id, live: t.expires > now }] };
      }
      if (/DELETE FROM login_tokens WHERE token/.test(sql)) {
        const record = tokens.get(p[0]!);
        if (/used = false/.test(sql) && record?.used) return { rows: [] };
        tokens.delete(p[0]!);
        return /RETURNING email/.test(sql) && record
          ? { rows: [{ email: record.email, live: record.expires > now }] }
          : { rows: [] };
      }
      if (/INSERT INTO sessions/.test(sql)) {
        sessions.set(p[0]!, { user_id: p[1]!, expires: now + 30 * 86_400_000 });
        return { rows: [] };
      }
      if (/UPDATE sessions SET expires/.test(sql)) {
        const s = sessions.get(p[0]!);
        if (!s || s.expires <= now) return { rows: [] };
        s.expires = now + 30 * 86_400_000;
        return { rows: [{ user_id: s.user_id }] };
      }
      if (/DELETE FROM sessions WHERE id = ANY/.test(sql)) {
        const ids = Array.isArray(params[0]) ? params[0].map(String) : [];
        for (const id of new Set(ids)) sessions.delete(id);
        return { rows: [] };
      }
      if (/DELETE FROM sessions/.test(sql)) {
        sessions.delete(p[0]!);
        return { rows: [] };
      }
      if (/INSERT INTO mutation_calls/.test(sql)) {
        const windowMs = Number(p[2]);
        for (const [id, call] of mutationCalls) {
          if (call.started_at <= now - windowMs
              && (call.released_at !== null || call.lease_expires <= now))
            mutationCalls.delete(id);
        }
        const recent = [...mutationCalls.values()]
          .filter(call => call.started_at > now - windowMs);
        const active = recent.filter(call => call.released_at === null && call.lease_expires > now);
        if (recent.length >= Number(p[5])
            || recent.filter(call => call.user_id === p[1]).length >= Number(p[4])
            || active.length >= Number(p[7])
            || active.filter(call => call.user_id === p[1]).length >= Number(p[6]))
          return { rows: [] };
        mutationCalls.set(p[0]!, {
          user_id: p[1]!, started_at: now,
          lease_expires: now + Number(p[3]), released_at: null,
        });
        return { rows: [{ id: p[0] }] };
      }
      if (/UPDATE mutation_calls SET released_at/.test(sql)) {
        const call = mutationCalls.get(p[0]!);
        if (call && call.released_at === null) call.released_at = now;
        return { rows: [] };
      }
      if (/INSERT INTO repair_capabilities/.test(sql)) {
        for (const [token, capability] of repairCapabilities) {
          if (capability.expires <= now || capability.consumed_at !== null)
            repairCapabilities.delete(token);
        }
        repairCapabilities.set(p[0]!, {
          user_id: p[1]!, session_digest: p[2]!, context_digest: p[3]!,
          plan_digest: p[4]!, expires: now + 15 * 60_000, consumed_at: null,
        });
        return { rows: [] };
      }
      if (/UPDATE repair_capabilities SET consumed_at/.test(sql)) {
        const capability = repairCapabilities.get(p[0]!);
        if (!capability || capability.consumed_at !== null || capability.expires <= now
            || capability.user_id !== p[1] || capability.session_digest !== p[2]
            || capability.context_digest !== p[3] || capability.plan_digest !== p[4])
          return { rows: [] };
        capability.consumed_at = now;
        return { rows: [{ token: p[0] }] };
      }
      throw new Error(`fakePool: unrecognized SQL: ${sql}`);
    },
  };
  return pool;
}

/** A fresh "serverless instance": new store + sessions over the shared pool. */
function instance(pool: Queryable, mutationConcurrency?: number): ReturnType<typeof createApp> {
  const store = new PostgresAuthStore(pool);
  return createApp({ apiKey: "k", makeClient: () => fakeClient,
    auth: { store, sessions: new PgSessions(pool), devLinks: true },
    ...(mutationConcurrency === undefined ? {} : { mutationConcurrency }) });
}

describe("serverless statelessness (Vercel deploy path)", () => {
  it("fails closed when any production auth dependency is missing", async () => {
    const app = await buildServerlessApp({ ANTHROPIC_API_KEY: "sk-test" });
    expect((await app.request("/healthz")).status).toBe(503);
    expect((await app.request("/mutations/plan", { method: "POST" })).status).toBe(503);
  });

  it("sign-in on instance A is visible to instances B and C", async () => {
    const pool = fakePool();
    const a = instance(pool);
    const linkRes = await a.request("/auth/magic-link", { method: "POST",
      body: authBody("vercel@example.com"),
      headers: { "content-type": "application/json" } });
    const { link } = await linkRes.json() as { link: string };

    const b = instance(pool);                       // fresh instance redeems
    const cb = await b.request(link);
    expect(cb.status).toBe(200);
    const { session } = await cb.json() as { session: string };

    const c = instance(pool);                       // a third reads /me
    const me = await c.request("/me", { headers: { authorization: `Bearer ${session}` } });
    expect(me.status).toBe(200);
    expect((await me.json() as { email: string }).email).toBe("vercel@example.com");
  });

  it("tokens are single-use and rate-limited across instances", async () => {
    const pool = fakePool();
    const issue = () => instance(pool).request("/auth/magic-link", { method: "POST",
      body: authBody("hot@example.com"),
      headers: { "content-type": "application/json" } });
    const { link } = await (await issue()).json() as { link: string };
    expect((await instance(pool).request(link)).status).toBe(200);
    expect((await instance(pool).request(link)).status).toBe(401);  // single-use
    await issue(); await issue();
    expect((await issue()).status).toBe(429);       // 3/hour survives instances
  });

  it("does not resurrect a previously redeemed token during schema migration", async () => {
    const pool = fakePool();
    const token = pool.seedUsedToken("already-used@example.com");
    await expect(new PgSessions(pool).consumeLink(token)).resolves.toBeNull();
    expect(pool.userCount()).toBe(0);
  });

  it("atomically bounds issuance without users and purges expired token rows", async () => {
    const issuanceSchema = SCHEMA_SQL.slice(
      SCHEMA_SQL.indexOf("CREATE TABLE IF NOT EXISTS magic_link_issuances"),
      SCHEMA_SQL.indexOf("CREATE INDEX IF NOT EXISTS magic_link_issuances_created_idx"),
    );
    expect(issuanceSchema).toContain("email_digest TEXT NOT NULL");
    expect(issuanceSchema).not.toContain("\n  email TEXT");
    const pool = fakePool();
    const issue = (email: string) => instance(pool).request("/auth/magic-link", {
      method: "POST", body: authBody(email),
      headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.10" },
    });
    const raced = await Promise.all(Array.from({ length: 12 }, () =>
      issue("raced@example.com")));
    expect(raced.filter(response => response.status === 200)).toHaveLength(3);
    expect(raced.filter(response => response.status === 429)).toHaveLength(9);
    expect(pool.userCount()).toBe(0);
    expect(pool.tokenCount()).toBe(3);

    pool.skew = 61 * 60_000;
    expect((await issue("fresh@example.com")).status).toBe(200);
    expect(pool.userCount()).toBe(0);
    expect(pool.tokenCount()).toBe(1);
  });

  it("sessions expire and metering persists across instances", async () => {
    const pool = fakePool();
    const a = instance(pool);
    const { link } = await (await a.request("/auth/magic-link", { method: "POST",
      body: authBody("meter@example.com"),
      headers: { "content-type": "application/json" } })).json() as { link: string };
    const { session } = await (await a.request(link)).json() as { session: string };

    const plan = () => instance(pool).request("/mutations/plan", { method: "POST",
      body: JSON.stringify({ context: { intent: "x", registry: [], panels: [] } }),
      headers: { "content-type": "application/json",
        authorization: `Bearer ${session}` } });
    expect((await plan()).status).toBe(200);
    const me = await instance(pool).request("/me",
      { headers: { authorization: `Bearer ${session}` } });
    expect((await me.json() as { mutations_used: number }).mutations_used).toBe(1);

    pool.skew = 31 * 86_400_000;                    // a month later
    expect((await instance(pool).request("/me",
      { headers: { authorization: `Bearer ${session}` } })).status).toBe(401);
  });

  it("atomically revokes distinct bearer and cookie sessions across instances", async () => {
    const pool = fakePool();
    const makeSession = async (): Promise<string> => {
      const { link } = await (await instance(pool).request("/auth/magic-link", {
        method: "POST", body: authBody("dual@example.com"),
        headers: { "content-type": "application/json" },
      })).json() as { link: string };
      return (await (await instance(pool).request(link)).json() as { session: string }).session;
    };
    const cookieSession = await makeSession();
    const bearerSession = await makeSession();
    const logout = await instance(pool).request("/auth/logout", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearerSession}`,
        cookie: `clay_session=${cookieSession}`,
      },
    });
    expect(logout.status).toBe(204);
    for (const session of [bearerSession, cookieSession]) {
      expect((await instance(pool).request("/me", {
        headers: { authorization: `Bearer ${session}` },
      })).status).toBe(401);
    }
  });

  it("keeps the Postgres quota atomic across concurrent serverless instances", async () => {
    const pool = fakePool();
    const start = instance(pool);
    const { link } = await (await start.request("/auth/magic-link", { method: "POST",
      body: authBody("atomic@example.com"),
      headers: { "content-type": "application/json" } })).json() as { link: string };
    const { session } = await (await instance(pool).request(link)).json() as { session: string };
    const calls = await Promise.all(Array.from({ length: FREE_QUOTA + 8 }, () =>
      instance(pool, FREE_QUOTA + 8).request("/mutations/plan", { method: "POST",
        body: JSON.stringify({ context: { intent: "x", registry: [], panels: [] } }),
        headers: { "content-type": "application/json", authorization: `Bearer ${session}` },
      })));
    expect(calls.filter(response => response.status === 200)).toHaveLength(FREE_QUOTA);
    expect(calls.filter(response => response.status === 429)).toHaveLength(8);
  });

  it("durably shares provider-call rate and concurrency leases across instances", async () => {
    const pool = fakePool();
    const limits: MutationCallLimits = {
      windowMs: 60_000,
      maxPerUser: 2,
      maxGlobal: 2,
      maxConcurrentPerUser: 1,
      maxConcurrentGlobal: 1,
      leaseMs: 10_000,
    };
    const first = new PgSessions(pool);
    const second = new PgSessions(pool);
    const lease1 = await first.acquireMutationCall("user-a", limits);
    expect(lease1).toMatch(/^[a-f0-9]{48}$/);
    await expect(second.acquireMutationCall("user-b", limits)).resolves.toBeNull();
    await first.releaseMutationCall(lease1!);
    const lease2 = await second.acquireMutationCall("user-a", limits);
    expect(lease2).toMatch(/^[a-f0-9]{48}$/);
    await second.releaseMutationCall(lease2!);
    await expect(new PgSessions(pool).acquireMutationCall("user-a", limits))
      .resolves.toBeNull();
  });

  it("takes each count-and-insert admission under a dedicated database transaction", async () => {
    const calls: string[] = [];
    let releases = 0;
    const client = {
      async query(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
        calls.push(sql.trim().replace(/\s+/g, " "));
        if (/INSERT INTO (?:login_tokens|mutation_calls)/.test(sql))
          return { rows: [{ admitted: true }] };
        return { rows: [] };
      },
      release(): void { releases++; },
    };
    const pool = {
      async query(): Promise<{ rows: Record<string, unknown>[] }> {
        throw new Error("admission escaped its dedicated transaction");
      },
      async connect() { return client; },
    } as unknown as Queryable;
    const sessions = new PgSessions(pool);
    await sessions.issueLink("transaction@example.com", "source", {
      windowMs: 60_000, maxPerEmail: 3, maxPerSource: 10, maxGlobal: 100,
    });
    await sessions.acquireMutationCall("user-a", {
      windowMs: 60_000, maxPerUser: 3, maxGlobal: 10,
      maxConcurrentPerUser: 1, maxConcurrentGlobal: 2, leaseMs: 10_000,
    });
    expect(calls.filter(sql => sql === "BEGIN ISOLATION LEVEL READ COMMITTED"))
      .toHaveLength(2);
    expect(calls.filter(sql => sql === "COMMIT")).toHaveLength(2);
    expect(calls.filter(sql => /pg_advisory_xact_lock/.test(sql))).toHaveLength(2);
    expect(releases).toBe(2);
    const firstLock = calls.findIndex(sql => /pg_advisory_xact_lock/.test(sql));
    const firstInsert = calls.findIndex(sql => /INSERT INTO login_tokens/.test(sql));
    expect(firstLock).toBeGreaterThan(calls.indexOf("BEGIN ISOLATION LEVEL READ COMMITTED"));
    expect(firstInsert).toBeGreaterThan(firstLock);
  });

  it("atomically consumes a repair capability across fresh instances", async () => {
    const pool = fakePool();
    const binding: RepairCapabilityBinding = {
      userId: "user-a",
      sessionDigest: "s".repeat(64),
      contextDigest: "c".repeat(64),
      planDigest: "p".repeat(64),
    };
    const token = await new PgSessions(pool).issueRepairCapability(binding);
    await expect(new PgSessions(pool).consumeRepairCapability(token, {
      ...binding, planDigest: "x".repeat(64),
    })).resolves.toBe(false);
    const concurrent = await Promise.all([
      new PgSessions(pool).consumeRepairCapability(token, binding),
      new PgSessions(pool).consumeRepairCapability(token, binding),
    ]);
    expect(concurrent.filter(Boolean)).toHaveLength(1);
  });
});
