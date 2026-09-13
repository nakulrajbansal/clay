import { describe, expect, it, vi } from "vitest";
import type { ShareCreateRequestV1 } from "@clay/schema/share";
import { BrowserShareRelayClient, ShareRelayClientError } from "../src/share/relay-client";

const shareId = "shr_abcdefghijklmnopqrstuvwxyz";
const token = "A".repeat(43);
const request: ShareCreateRequestV1 = {
  schema: 1,
  shareId,
  expiresAt: "2026-09-08T12:00:00.000Z",
  revokeTokenHash: "B".repeat(43),
  envelope: {
    schema: 1,
    algorithm: "A256GCM",
    iv: "C".repeat(16),
    ciphertext: "D".repeat(24),
  },
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}

describe("strict browser share relay client", () => {
  it("rejects insecure remote origins and treats absent/expired ciphertext as terminal revocation", async () => {
    expect(() => new BrowserShareRelayClient("http://remote.example", null)).toThrow(/HTTPS|secure/);
    const fetcher = vi.fn(async () => response({ schema: 1, error: "expired" }, 410));
    const client = new BrowserShareRelayClient("https://relay.example", null, fetcher);
    await expect(client.revoke(shareId, token)).resolves.toMatchObject({ shareId, revoked: true });
  });
  it("creates with ciphertext only and reads without sending cookies, keys, or fragments", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") return response({
        schema: 1, shareId, expiresAt: request.expiresAt,
      }, 201);
      return response({
        schema: 1, shareId, expiresAt: request.expiresAt, envelope: request.envelope,
      });
    });
    const client = new BrowserShareRelayClient(
      "https://relay.example/api/", "owner-session", fetcher);
    await expect(client.create(request)).resolves.toEqual({
      schema: 1, shareId, expiresAt: request.expiresAt,
    });
    await expect(client.read(shareId)).resolves.toMatchObject({ shareId });

    const createCall = fetcher.mock.calls[0]!;
    expect(String(createCall[0])).toBe("https://relay.example/api/shares");
    expect(createCall[1]).toMatchObject({
      method: "POST", credentials: "include", cache: "no-store",
    });
    expect((createCall[1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer owner-session");
    expect(String(createCall[1]?.body)).toBe(JSON.stringify(request));
    expect(String(createCall[1]?.body)).not.toContain("plaintext");

    const readCall = fetcher.mock.calls[1]!;
    expect(String(readCall[0])).toBe(`https://relay.example/api/shares/${shareId}`);
    expect(readCall[1]).toMatchObject({
      method: "GET", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
    });
    expect(JSON.stringify(readCall)).not.toContain(token);
  });

  it("revokes with only the owner revocation capability", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response({ schema: 1, shareId, revoked: true }));
    const client = new BrowserShareRelayClient("https://relay.example", null, fetcher);
    await expect(client.revoke(shareId, token)).resolves.toEqual({
      schema: 1, shareId, revoked: true,
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://relay.example/shares/${shareId}/revoke`);
    expect(init?.body).toBe(JSON.stringify({ schema: 1, revokeToken: token }));
    expect(init?.headers).toEqual({ "content-type": "application/json" });
  });

  it("fails closed on relay errors and malformed successful responses", async () => {
    const expired = new BrowserShareRelayClient("https://relay.example", null,
      async () => response({ schema: 1, error: "expired" }, 410));
    await expect(expired.read(shareId)).rejects.toMatchObject({
      code: "expired", status: 410,
    });
    const malformed = new BrowserShareRelayClient("https://relay.example", null,
      async () => response({ schema: 1, shareId, expiresAt: request.expiresAt,
        envelope: request.envelope, plaintext: { leaked: true } }));
    await expect(malformed.read(shareId)).rejects.toThrow(/invalid.*relay/i);
  });
});
