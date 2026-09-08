import { describe, expect, it, vi } from "vitest";
import { SCHEMA_SQL, type Queryable } from "../src/pg-store";
import {
  PostgresShareRelayStore, SHARE_RELAY_SCHEMA_SQL,
} from "../src/share-pg-store";
import type { ShareRelayRecordV1 } from "../src/share-store";

const NOW = Date.parse("2026-09-07T12:00:00.000Z");
const shareId = "shr_abcdefghijklmnopqrstuvwxyz";
const record: ShareRelayRecordV1 = {
  shareId,
  createdAt: "2026-09-07T12:00:00.000Z",
  expiresAt: "2026-09-08T12:00:00.000Z",
  ownerId: "owner-1",
  revokeTokenHash: "B".repeat(43),
  envelope: {
    schema: 1,
    algorithm: "A256GCM",
    iv: "A".repeat(16),
    ciphertext: "C".repeat(86),
  },
  ciphertextBytes: 64,
};

type Row = Record<string, unknown>;
function fakePool(): Queryable & {
  connect(): Promise<Queryable & { release(): void }>;
} {
  const rows = new Map<string, Row>();
  const query = async (sql: string, params: unknown[] = []): Promise<{ rows: Row[] }> => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK"
        || /pg_advisory_xact_lock/.test(sql)) return { rows: [] };
    if (/DELETE FROM share_links/.test(sql)) {
      const now = Date.parse(String(params[0]));
      for (const [id, row] of rows) {
        if (Date.parse(String(row.expires_at)) <= now
            && (row.owner_id ?? null) === (params[1] ?? null)) rows.delete(id);
      }
      return { rows: [] };
    }
    if (/INSERT INTO share_links/.test(sql)) {
      const id = String(params[0]);
      if (rows.has(id)) return { rows: [] };
      rows.set(id, {
        id,
        ciphertext: params[1],
        iv: params[2],
        expires_at: params[3],
        created_at: params[4],
        owner_id: params[5],
        revoke_token_hash: params[6],
        ciphertext_bytes: params[7],
        revoked_at: null,
      });
      return { rows: [{ id }] };
    }
    if (/^SELECT id FROM share_links/.test(sql)) {
      const row = rows.get(String(params[0]));
      return { rows: row ? [{ id: row.id }] : [] };
    }
    if (/SELECT id, ciphertext, iv, expires_at/.test(sql)) {
      const row = rows.get(String(params[0]));
      return { rows: row ? [{ ...row }] : [] };
    }
    if (/UPDATE share_links SET revoked_at/.test(sql)) {
      const row = rows.get(String(params[0]));
      const now = Date.parse(String(params[2]));
      if (!row || row.revoke_token_hash !== params[1]
          || Date.parse(String(row.expires_at)) <= now) return { rows: [] };
      row.revoked_at = params[2];
      return { rows: [{ id: row.id }] };
    }
    throw new Error(`unrecognized share SQL: ${sql}`);
  };
  return {
    query,
    async connect() { return { query, release() { /* fake pooled client */ } }; },
  };
}

describe("Postgres F1 relay storage adapter", () => {
  it("reclaims expired rows and bounds each owner's active ciphertext before insert", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const query = async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: /INSERT INTO share_links/.test(sql) ? [{ id: shareId }] : [] };
    };
    const release = vi.fn();
    const pool = {
      query,
      connect: async () => ({ query, release }),
    };
    expect(await new PostgresShareRelayStore(pool).create(record, NOW)).toBe("created");
    expect(calls[0]?.sql).toBe("BEGIN");
    expect(calls[1]?.sql).toMatch(/pg_advisory_xact_lock/);
    expect(calls[2]?.sql).toMatch(/DELETE FROM share_links[\s\S]*expires_at/i);
    const insert = calls.find(call => /INSERT INTO share_links/.test(call.sql))!;
    expect(insert.sql).toMatch(/COUNT\(\*\)[\s\S]*100/i);
    expect(insert.sql).toMatch(/SUM\(ciphertext_bytes\)[\s\S]*67108864/i);
    expect(insert.sql).not.toMatch(/revoked_at IS NULL/i);
    expect(insert.params).not.toContain("Approved result");
    expect(calls.at(-1)?.sql).toBe("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });

  it("installs only bounded ciphertext and delivery metadata columns", () => {
    expect(SCHEMA_SQL).toContain(SHARE_RELAY_SCHEMA_SQL.trim());
    expect(SHARE_RELAY_SCHEMA_SQL).toContain("ciphertext TEXT NOT NULL");
    expect(SHARE_RELAY_SCHEMA_SQL).toContain("ciphertext_bytes INTEGER NOT NULL");
    expect(SHARE_RELAY_SCHEMA_SQL).toContain("CHECK (ciphertext_bytes");
    expect(SHARE_RELAY_SCHEMA_SQL).not.toMatch(/plaintext|record_json|canonical_write/i);
  });

  it("persists active, expired, and revoked state across fresh adapter instances", async () => {
    const pool = fakePool();
    const a = new PostgresShareRelayStore(pool);
    const b = new PostgresShareRelayStore(pool);
    expect(await a.create(record, NOW)).toBe("created");
    expect(await b.create(record, NOW)).toBe("conflict");
    expect(await b.lookup(shareId, NOW)).toEqual({ state: "active", record });
    expect(await b.revoke(shareId, "wrong".repeat(9).slice(0, 43), NOW)).toBe("forbidden");
    expect((await a.lookup(shareId, NOW)).state).toBe("active");
    expect(await b.revoke(shareId, record.revokeTokenHash, NOW)).toBe("revoked");
    expect(await a.lookup(shareId, NOW)).toEqual({ state: "revoked" });
    expect(await a.create(record, NOW)).toBe("conflict");

    const expiring = { ...record, shareId: "shr_bcdefghijklmnopqrstuvwxyza" };
    expect(await a.create(expiring, NOW)).toBe("created");
    expect(await b.lookup(expiring.shareId, Date.parse(expiring.expiresAt)))
      .toEqual({ state: "expired" });
    expect(await b.lookup("shr_cdefghijklmnopqrstuvwxyzab", NOW))
      .toEqual({ state: "not_found" });
  });
});
