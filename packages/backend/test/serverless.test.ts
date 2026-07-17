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

const fakeClient = { rawPlan: async () => "{}", rawRepair: async () => "{}" };

/** In-memory emulation of the exact statements pg-store.ts uses. */
function fakePool(): Queryable & { now: () => number; skew: number } {
  type Row = Record<string, unknown>;
  const users: Row[] = [];
  const usage = new Map<string, { period_start: number; mutations_used: number }>();
  const tokens = new Map<string, { user_id: string; email: string; expires: number; used: boolean; created_at: number }>();
  const sessions = new Map<string, { user_id: string; expires: number }>();
  const pool = {
    skew: 0,
    now(): number { return Date.now() + this.skew; },
    async query(sql: string, params: unknown[] = []): Promise<{ rows: Row[] }> {
      const p = params.map(String);
      const now = this.now();
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
      throw new Error(`fakePool: unrecognized SQL: ${sql}`);
    },
  };
  return pool;
}

/** A fresh "serverless instance": new store + sessions over the shared pool. */
function instance(pool: Queryable): ReturnType<typeof createApp> {
  const store = new PostgresAuthStore(pool);
  return createApp({ apiKey: "k", makeClient: () => fakeClient,
    auth: { store, sessions: new PgSessions(pool), devLinks: true } });
}

describe("serverless statelessness (Vercel deploy path)", () => {
  it("sign-in on instance A is visible to instances B and C", async () => {
    const pool = fakePool();
    const a = instance(pool);
    const linkRes = await a.request("/auth/magic-link", { method: "POST",
      body: JSON.stringify({ email: "vercel@example.com" }),
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
      body: JSON.stringify({ email: "hot@example.com" }),
      headers: { "content-type": "application/json" } });
    const { link } = await (await issue()).json() as { link: string };
    expect((await instance(pool).request(link)).status).toBe(200);
    expect((await instance(pool).request(link)).status).toBe(401);  // single-use
    await issue(); await issue();
    expect((await issue()).status).toBe(429);       // 3/hour survives instances
  });

  it("sessions expire and metering persists across instances", async () => {
    const pool = fakePool();
    const a = instance(pool);
    const { link } = await (await a.request("/auth/magic-link", { method: "POST",
      body: JSON.stringify({ email: "meter@example.com" }),
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
});
