import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createApp, makeDevAuth } from "../src/app";
import {
  MemoryIntakeRelayStore,
  PostgresIntakeRelayStore,
  RELAY_SCHEMA_SQL,
} from "../src/intake-relay";

const now = Date.parse("2026-09-07T12:00:00.000Z");
const formId = "form_abcdefghijklmnopqrstuvwxyz";
const ownerToken = "o".repeat(43);
const submitToken = "s".repeat(43);
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const boundedSubmissionId = (index: number): string => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return `sub_${"a".repeat(24)}${alphabet[Math.floor(index / 32)]}${alphabet[index % 32]}`;
};
const envelope = {
  schema: 1 as const,
  algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM" as const,
  ephemeralPublicKey: "A".repeat(87),
  salt: "A".repeat(22),
  iv: "A".repeat(16),
  ciphertext: "c2VjcmV0LWNpcGhlcnRleHQ",
};

function json(body: unknown, token?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  };
}

async function register(app: ReturnType<typeof createApp>, maxCiphertextBytes = 4096): Promise<Response> {
  return app.request("/intake/forms", json({
    schema: 1,
    formId,
    ownerToken,
    submitToken,
    expiresAt: "2026-10-01T00:00:00.000Z",
    maxCiphertextBytes,
  }));
}

describe("ciphertext-only intake relay", () => {
  it("refuses unauthenticated form allocation when account auth is configured", async () => {
    const auth = makeDevAuth();
    const relay = new MemoryIntakeRelayStore({ now: () => now });
    const app = createApp({ auth, intakeRelay: relay });

    expect((await register(app)).status).toBe(401);

    const user = await auth.store.upsertUser("owner@example.test");
    const session = await auth.sessions.createSession(user.id);
    const authorized = await app.request("/intake/forms", {
      ...json({
        schema: 1, formId, ownerToken, submitToken,
        expiresAt: "2026-10-01T00:00:00.000Z", maxCiphertextBytes: 4096,
      }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session}`,
        "x-forwarded-for": "192.0.2.10",
      },
    });
    expect(authorized.status).toBe(201);
  });

  it("transactionally limits active form allocation per publisher and source", async () => {
    const auth = makeDevAuth();
    const relay = new MemoryIntakeRelayStore({
      now: () => now,
      maxFormsPerPublisher: 1,
      maxFormsPerSource: 1,
      maxRegistrationsPerSourceWindow: 10,
    } as unknown as ConstructorParameters<typeof MemoryIntakeRelayStore>[0]);
    const app = createApp({ auth, intakeRelay: relay });
    const sessionFor = async (email: string): Promise<string> => {
      const user = await auth.store.upsertUser(email);
      return auth.sessions.createSession(user.id);
    };
    const registerAs = async (id: string, session: string, source: string): Promise<Response> =>
      await app.request("/intake/forms", {
        ...json({
          schema: 1, formId: id,
          ownerToken: id.endsWith("b") ? "p".repeat(43) : "o".repeat(43),
          submitToken: id.endsWith("b") ? "q".repeat(43) : "s".repeat(43),
          expiresAt: "2026-10-01T00:00:00.000Z", maxCiphertextBytes: 4096,
        }),
        headers: {
          "content-type": "application/json", authorization: `Bearer ${session}`,
          "x-forwarded-for": source,
        },
      });

    const firstSession = await sessionFor("first@example.test");
    expect((await registerAs("form_aaaaaaaaaaaaaaaaaaaaaaaaaa", firstSession, "192.0.2.1")).status)
      .toBe(201);
    expect((await registerAs("form_bbbbbbbbbbbbbbbbbbbbbbbbbb", firstSession, "192.0.2.2")).status)
      .toBe(429);

    const sourceRelay = new MemoryIntakeRelayStore({
      now: () => now,
      maxFormsPerPublisher: 10,
      maxFormsPerSource: 1,
      maxRegistrationsPerSourceWindow: 10,
    } as unknown as ConstructorParameters<typeof MemoryIntakeRelayStore>[0]);
    const sourceApp = createApp({ auth, intakeRelay: sourceRelay });
    const secondSession = await sessionFor("second@example.test");
    const sourceRegister = async (id: string, session: string): Promise<Response> => await sourceApp.request(
      "/intake/forms",
      {
        ...json({
          schema: 1, formId: id,
          ownerToken: id.endsWith("c") ? "r".repeat(43) : "o".repeat(43),
          submitToken: id.endsWith("c") ? "t".repeat(43) : "s".repeat(43),
          expiresAt: "2026-10-01T00:00:00.000Z", maxCiphertextBytes: 4096,
        }),
        headers: {
          "content-type": "application/json", authorization: `Bearer ${session}`,
          "x-forwarded-for": "198.51.100.7",
        },
      },
    );
    expect((await sourceRegister("form_aaaaaaaaaaaaaaaaaaaaaaaaaa", firstSession)).status).toBe(201);
    expect((await sourceRegister("form_cccccccccccccccccccccccccc", secondSession)).status).toBe(429);
  });

  it("authenticates before parsing submission bodies and byte-bounds delivery pages", async () => {
    const relay = new MemoryIntakeRelayStore({
      now: () => now,
      maxPendingPerForm: 60,
      maxTotalCiphertextBytes: 32 * 1024 * 1024,
      maxCiphertextBytesPerForm: 32 * 1024 * 1024,
    });
    const app = createApp({ intakeRelay: relay });
    expect((await register(app, 512 * 1024)).status).toBe(201);

    const malformed = await app.request(`/intake/forms/${formId}/submissions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${"x".repeat(43)}`,
      },
      body: `{${"x".repeat(128 * 1024)}`,
    });
    expect(malformed.status).toBe(401);

    const largeEnvelope = { ...envelope, ciphertext: "A".repeat(400_000) };
    for (let index = 0; index < 50; index++) {
      await relay.putSubmission(sha256(submitToken), {
        formId,
        submissionId: boundedSubmissionId(index),
        envelope: largeEnvelope,
        ciphertextBytes: 300_000,
      });
    }
    const page = await relay.listSubmissions(formId, sha256(ownerToken), 50, null);
    expect(page.hasMore).toBe(true);
    expect(page.items.length).toBeLessThan(50);
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(
      Math.ceil(12 * 1024 * 1024 * 4 / 3) + 128 * 1024,
    );
  });

  it("durably reclaims expired forms and ciphertext without owner traffic", async () => {
    let clock = now;
    const relay = new MemoryIntakeRelayStore({
      now: () => clock, maxForms: 1, maxTotalCiphertextBytes: 1024,
    });
    await relay.register({
      formId,
      ownerTokenSha256: sha256(ownerToken), submitTokenSha256: sha256(submitToken),
      publisherIdSha256: sha256("publisher"), sourceSha256: sha256("source"),
      expiresAt: new Date(now + 1_000).toISOString(), maxCiphertextBytes: 1024,
    });
    await relay.putSubmission(sha256(submitToken), {
      formId, submissionId: boundedSubmissionId(0), envelope, ciphertextBytes: 17,
    });
    clock = now + 2_000;

    const cleanup = Reflect.get(relay, "cleanupExpired") as (() => Promise<unknown>) | undefined;
    expect(typeof cleanup).toBe("function");
    await expect(cleanup!.call(relay)).resolves.toEqual({ forms: 1, submissions: 1 });
    await expect(relay.register({
      formId: "form_bbbbbbbbbbbbbbbbbbbbbbbbbb",
      ownerTokenSha256: sha256("p".repeat(43)), submitTokenSha256: sha256("q".repeat(43)),
      publisherIdSha256: sha256("publisher"), sourceSha256: sha256("source"),
      expiresAt: new Date(clock + 1_000).toISOString(), maxCiphertextBytes: 1024,
    })).resolves.toEqual({ created: true });
  });

  it("exposes cleanup only to the deployment scheduler capability", async () => {
    const relay = new MemoryIntakeRelayStore({ now: () => now });
    const cleanup = vi.spyOn(relay, "cleanupExpired");
    const app = createApp({
      intakeRelay: relay,
      intakeCleanupToken: "cleanup-capability",
    } as Parameters<typeof createApp>[0]);

    expect((await app.request("/internal/intake/cleanup")).status).toBe(401);
    const response = await app.request("/internal/intake/cleanup", {
      headers: { authorization: "Bearer cleanup-capability" },
    });
    expect(response.status).toBe(200);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("registers separate capabilities and relays only a bounded encrypted envelope", async () => {
    const relay = new MemoryIntakeRelayStore({ now: () => now });
    const app = createApp({ intakeRelay: relay });
    expect((await register(app)).status).toBe(201);

    const submissionId = "sub_abcdefghijklmnopqrstuvwxyz";
    const accepted = await app.request(`/intake/forms/${formId}/submissions`, json({
      schema: 1, submissionId, envelope,
    }, submitToken));
    expect(accepted.status).toBe(201);

    const denied = await app.request(`/intake/forms/${formId}/submissions`, {
      headers: { authorization: `Bearer ${submitToken}` },
    });
    expect(denied.status).toBe(401);

    const inbox = await app.request(`/intake/forms/${formId}/submissions?limit=10`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(inbox.status).toBe(200);
    const response = await inbox.json() as { items: unknown[]; hasMore: boolean };
    expect(response.items).toHaveLength(1);
    expect(response.hasMore).toBe(false);
    expect(JSON.stringify(response)).not.toContain("ownerToken");
    expect(JSON.stringify(response)).not.toContain("submitToken");
    expect(JSON.stringify(response)).not.toContain("plaintext");
    expect(JSON.stringify(response)).toContain(envelope.ciphertext);

    const removed = await app.request(`/intake/forms/${formId}/submissions/${submissionId}`, {
      method: "DELETE", headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(removed.status).toBe(204);
    expect((await (await app.request(`/intake/forms/${formId}/submissions`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    })).json() as { items: unknown[] }).items).toEqual([]);
  });

  it("rejects plaintext, malformed capabilities, duplicate conflicts, item overflow, and queue overflow", async () => {
    const relay = new MemoryIntakeRelayStore({ now: () => now, maxPendingPerForm: 2 });
    const app = createApp({ intakeRelay: relay });
    expect((await register(app, 1024)).status).toBe(201);

    const plaintext = await app.request(`/intake/forms/${formId}/submissions`, json({
      schema: 1,
      submissionId: "sub_abcdefghijklmnopqrstuvwxyz",
      envelope,
      plaintext: { name: "must never reach relay storage" },
    }, submitToken));
    expect(plaintext.status).toBe(400);

    const wrongToken = await app.request(`/intake/forms/${formId}/submissions`, json({
      schema: 1, submissionId: "sub_abcdefghijklmnopqrstuvwxyz", envelope,
    }, "x".repeat(43)));
    expect(wrongToken.status).toBe(401);

    const first = await app.request(`/intake/forms/${formId}/submissions`, json({
      schema: 1, submissionId: "sub_abcdefghijklmnopqrstuvwxyz", envelope,
    }, submitToken));
    expect(first.status).toBe(201);
    const replay = await app.request(`/intake/forms/${formId}/submissions`, json({
      schema: 1, submissionId: "sub_abcdefghijklmnopqrstuvwxyz", envelope,
    }, submitToken));
    expect(replay.status).toBe(200);
    const conflict = await app.request(`/intake/forms/${formId}/submissions`, json({
      schema: 1,
      submissionId: "sub_abcdefghijklmnopqrstuvwxyz",
      envelope: { ...envelope, ciphertext: "ZGlmZmVyZW50" },
    }, submitToken));
    expect(conflict.status).toBe(409);

    expect((await app.request(`/intake/forms/${formId}/submissions`, json({
      schema: 1, submissionId: "sub_bcdefghijklmnopqrstuvwxyza", envelope,
    }, submitToken))).status).toBe(201);
    expect((await app.request(`/intake/forms/${formId}/submissions`, json({
      schema: 1, submissionId: "sub_cdefghijklmnopqrstuvwxyzab", envelope,
    }, submitToken))).status).toBe(429);

    const huge = { ...envelope, ciphertext: "A".repeat(1400) };
    const overflowRelay = new MemoryIntakeRelayStore({ now: () => now });
    const overflowApp = createApp({ intakeRelay: overflowRelay });
    expect((await register(overflowApp, 1024)).status).toBe(201);
    expect((await overflowApp.request(`/intake/forms/${formId}/submissions`, json({
      schema: 1, submissionId: "sub_abcdefghijklmnopqrstuvwxyz", envelope: huge,
    }, submitToken))).status).toBe(413);
  });

  it("ships a durable adapter whose schema has ciphertext and no plaintext columns", async () => {
    expect(RELAY_SCHEMA_SQL).toContain("envelope_json");
    expect(RELAY_SCHEMA_SQL).toContain("publisher_id_sha256");
    expect(RELAY_SCHEMA_SQL).toContain("source_sha256");
    expect(RELAY_SCHEMA_SQL).toContain("intake_relay_registration_events");
    expect(RELAY_SCHEMA_SQL).not.toMatch(/plaintext|field_value|file_name/i);
    const statements: string[] = [];
    const client = {
      query: async (sql: string): Promise<{ rows: Record<string, unknown>[] }> => {
        statements.push(sql);
        if (/SELECT \* FROM intake_relay_forms/i.test(sql)) return { rows: [] };
        if (/COUNT\(\*\)/i.test(sql)) return { rows: [{ n: 0 }] };
        if (/INSERT INTO intake_relay_forms/i.test(sql)) return { rows: [{ form_id: formId }] };
        return { rows: [] };
      },
      release: (): void => undefined,
    };
    const pool = {
      query: client.query,
      connect: async () => client,
    };
    const durable = new PostgresIntakeRelayStore(pool, { now: () => now });
    await expect(durable.register({
      formId,
      ownerTokenSha256: "1".repeat(64),
      submitTokenSha256: "2".repeat(64),
      publisherIdSha256: "3".repeat(64),
      sourceSha256: "4".repeat(64),
      expiresAt: "2026-10-01T00:00:00.000Z",
      maxCiphertextBytes: 4096,
    })).resolves.toEqual({ created: true });
    expect(statements.some(sql => /^BEGIN/i.test(sql))).toBe(true);
    expect(statements.some(sql => /^COMMIT/i.test(sql))).toBe(true);
    const cleanupIndex = statements.findIndex(sql => /DELETE FROM intake_relay_submissions[\s\S]*expires_at/iu.test(sql));
    const quotaIndex = statements.findIndex(sql => /COUNT\(\*\)[\s\S]*publisher_id_sha256/iu.test(sql));
    expect(cleanupIndex).toBeGreaterThan(-1);
    expect(quotaIndex).toBeGreaterThan(cleanupIndex);
  });
});
