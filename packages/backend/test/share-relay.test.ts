import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp, makeDevAuth } from "../src/app";
import {
  MemoryShareRelayStore, type ShareRelayRecordV1,
} from "../src/share-store";

const NOW = Date.parse("2026-09-07T12:00:00.000Z");
const shareId = "shr_abcdefghijklmnopqrstuvwxyz";
const revokeToken = Buffer.alloc(32, 7).toString("base64url");
const revokeTokenHash = createHash("sha256")
  .update(Buffer.from(revokeToken, "base64url")).digest("base64url");
const request = {
  schema: 1,
  shareId,
  expiresAt: "2026-09-08T12:00:00.000Z",
  revokeTokenHash,
  envelope: {
    schema: 1,
    algorithm: "A256GCM",
    iv: Buffer.alloc(12, 3).toString("base64url"),
    ciphertext: Buffer.alloc(64, 5).toString("base64url"),
  },
} as const;
const fakeClient = { rawPlan: async () => "{}", rawRepair: async () => "{}" };
const jsonHeaders: Record<string, string> = { "content-type": "application/json" };

function app(store = new MemoryShareRelayStore(), now: () => number = () => NOW) {
  return createApp({ apiKey: "sk-test", makeClient: () => fakeClient, shares: store, now });
}

async function createShare(target = app(), body: unknown = request, headers = jsonHeaders) {
  return target.request("/shares", {
    method: "POST", headers, body: JSON.stringify(body),
  });
}

describe("bounded ciphertext-only F1 relay", () => {
  it("permits only the owner browser's explicit share request headers", async () => {
    const response = await app().request("/shares", {
      method: "OPTIONS",
      headers: {
        origin: "https://owner.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-headers")?.toLowerCase())
      .toContain("authorization");
    expect(response.headers.get("access-control-allow-headers")?.toLowerCase())
      .toContain("content-type");
  });

  it("creates and returns only the strict encrypted envelope", async () => {
    const store = new MemoryShareRelayStore();
    const target = app(store);
    const created = await createShare(target);
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    expect(await created.json()).toEqual({
      schema: 1, shareId, expiresAt: request.expiresAt,
    });

    const stored: ShareRelayRecordV1 | undefined = store.inspectForTests(shareId);
    expect(stored).toEqual({
      shareId,
      expiresAt: request.expiresAt,
      createdAt: "2026-09-07T12:00:00.000Z",
      ownerId: null,
      revokeTokenHash,
      envelope: request.envelope,
      ciphertextBytes: 64,
    });
    expect(Object.keys(stored ?? {}).sort()).toEqual([
      "ciphertextBytes", "createdAt", "envelope", "expiresAt", "ownerId",
      "revokeTokenHash", "shareId",
    ]);
    expect(JSON.stringify(stored)).not.toContain("record");
    expect(JSON.stringify(stored)).not.toContain("plaintext");
    expect(JSON.stringify(stored)).not.toContain("decryption");

    const fetched = await target.request(`/shares/${shareId}`);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("cache-control")).toBe("no-store");
    expect(await fetched.json()).toEqual({
      schema: 1, shareId, expiresAt: request.expiresAt, envelope: request.envelope,
    });
  });

  it("rejects plaintext, keys, malformed IDs, duplicate IDs, and non-JSON without storing", async () => {
    const store = new MemoryShareRelayStore();
    const target = app(store);
    for (const body of [
      { ...request, plaintext: { secret: "LEAK" } },
      { ...request, decryptionKey: "D".repeat(43) },
      { ...request, shareId: "../admin" },
      { ...request, envelope: { ...request.envelope, rows: [{ secret: "LEAK" }] } },
    ]) expect((await createShare(target, body)).status).toBe(400);
    expect((await createShare(target, request, { "content-type": "text/plain" })).status).toBe(415);
    expect(store.size).toBe(0);

    expect((await createShare(target)).status).toBe(201);
    expect((await createShare(target)).status).toBe(409);
    expect(store.size).toBe(1);
  });

  it("enforces future/maximum expiry, body, ciphertext, entry, and byte bounds", async () => {
    expect((await createShare(app(), { ...request,
      expiresAt: "2026-09-07T12:00:00.000Z" })).status).toBe(400);
    expect((await createShare(app(), { ...request,
      expiresAt: "2026-10-08T12:00:00.001Z" })).status).toBe(400);
    const claimedLarge = await app().request("/shares", {
      method: "POST",
      headers: { ...jsonHeaders, "content-length": String(12 * 1024 * 1024 + 1) },
      body: JSON.stringify(request),
    });
    expect(claimedLarge.status).toBe(413);

    const noRoom = new MemoryShareRelayStore({
      maxEntries: 1, maxTotalCiphertextBytes: 63,
    });
    expect((await createShare(app(noRoom))).status).toBe(507);

    const oneSlot = new MemoryShareRelayStore({
      maxEntries: 1, maxTotalCiphertextBytes: 128,
    });
    expect((await createShare(app(oneSlot))).status).toBe(201);
    expect((await createShare(app(oneSlot), {
      ...request, shareId: "shr_bcdefghijklmnopqrstuvwxyza",
    })).status).toBe(507);
  });

  it("expires server-side and never returns expired ciphertext", async () => {
    let now = NOW;
    const store = new MemoryShareRelayStore();
    const target = app(store, () => now);
    expect((await createShare(target)).status).toBe(201);
    now = Date.parse(request.expiresAt);
    const expired = await target.request(`/shares/${shareId}`);
    expect(expired.status).toBe(410);
    const body = await expired.text();
    expect(JSON.parse(body)).toEqual({ schema: 1, error: "expired" });
    expect(body).not.toContain(request.envelope.ciphertext);
    expect(store.size).toBe(0);
  });

  it("revokes only with the separate owner capability and stops subsequent reads", async () => {
    const target = app();
    await createShare(target);
    const wrong = await target.request(`/shares/${shareId}/revoke`, {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ schema: 1, revokeToken: Buffer.alloc(32, 9).toString("base64url") }),
    });
    expect(wrong.status).toBe(403);
    expect((await target.request(`/shares/${shareId}`)).status).toBe(200);

    const revoked = await target.request(`/shares/${shareId}/revoke`, {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ schema: 1, revokeToken }),
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ schema: 1, shareId, revoked: true });
    const fetched = await target.request(`/shares/${shareId}`);
    expect(fetched.status).toBe(410);
    expect(await fetched.json()).toEqual({ schema: 1, error: "revoked" });

    expect((await createShare(target, {
      ...request, shareId: "shr_bcdefghijklmnopqrstuvwxyza",
    })).status).toBe(201);
    expect((await createShare(target)).status).toBe(409);
  });

  it("requires an authenticated owner for creation when hosted auth is enabled", async () => {
    const auth = makeDevAuth();
    const store = new MemoryShareRelayStore();
    const target = createApp({
      apiKey: "sk-test", makeClient: () => fakeClient, auth, shares: store, now: () => NOW,
    });
    expect((await createShare(target)).status).toBe(401);
    const magic = await target.request("/auth/magic-link", {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ email: "owner@example.com" }),
    });
    const { link } = await magic.json() as { link: string };
    const callback = await target.request(link);
    const { session } = await callback.json() as { session: string };
    const created = await createShare(target, request, {
      ...jsonHeaders, authorization: `Bearer ${session}`,
    });
    expect(created.status).toBe(201);
    expect(store.inspectForTests(shareId)?.ownerId).toMatch(/^[0-9a-f]{48}$/);
  });
});
