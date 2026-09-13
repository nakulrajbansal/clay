import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { MemoryIntakeRelayStore } from "../src/intake-relay";
import { MemoryShareRelayStore } from "../src/share-store";
import { ownedRelayApp } from "./helpers/owned-relay-app";

// Entirely synthetic capabilities. Never hydrate user custody in a relay fixture.
const start = Date.parse("2026-09-13T12:00:00.000Z");
const expiresAt = "2026-09-14T12:00:00.000Z";
const form = { schema: 1, formId: "form_abcdefghijklmnopqrstuvwxyz", ownerToken: "A".repeat(43),
  submitToken: "B".repeat(43), expiresAt, maxCiphertextBytes: 4096 };
const token = Buffer.alloc(32, 7).toString("base64url");
const share = { schema: 1, shareId: "shr_abcdefghijklmnopqrstuvwxyz", expiresAt,
  revokeTokenHash: createHash("sha256").update(Buffer.from(token, "base64url")).digest("base64url"),
  envelope: { schema: 1, algorithm: "A256GCM", iv: Buffer.alloc(12, 3).toString("base64url"), ciphertext: Buffer.alloc(64, 5).toString("base64url") } };
const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const digest = (body: unknown) => createHash("sha256").update(JSON.stringify(body)).digest("hex");

describe("exact relay publication terminalization", () => {
  it("retains an intake revocation through cleanup so the delayed original register cannot resurrect it", async () => {
    const relay = new MemoryIntakeRelayStore({ now: () => start });
    const app = ownedRelayApp({ intakeRelay: relay, now: () => start });
    expect((await app.request("/intake/forms", post(form))).status).toBe(201);
    expect((await app.request(`/intake/forms/${form.formId}`, { method: "DELETE", headers: { authorization: `Bearer ${form.ownerToken}` } })).status).toBe(204);
    await relay.cleanupExpired();
    expect((await app.request("/intake/forms", post(form))).status).toBe(409);
  });

  it("terminalizes an absent intake publication and replays the exact acknowledgement after teardown", async () => {
    const relay = new MemoryIntakeRelayStore({ now: () => start });
    const app = ownedRelayApp({ intakeRelay: relay, now: () => start });
    const path = `/intake/forms/${form.formId}/terminalize`;
    const first = await app.request(path, post(form));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ schema: 1, formId: form.formId, expiresAt, requestSha256: digest(form), terminal: true });
    await relay.cleanupExpired();
    // An HTTP invocation suspended before arrival still has the original body.
    expect((await app.request("/intake/forms", post(form))).status).toBe(409);
    expect((await app.request(path, post(form))).status).toBe(200);
    expect((await app.request(path, post({ ...form, submitToken: "C".repeat(43) }))).status).toBe(409);
    expect((await app.request(`/intake/forms/${form.formId}/submissions`, { headers: { authorization: `Bearer ${form.ownerToken}` } })).status).toBe(410);
  });

  it("terminalizes absent or published shares without accepting a missing-object snapshot as proof", async () => {
    const shares = new MemoryShareRelayStore();
    const app = ownedRelayApp({ shares, now: () => start });
    const path = `/shares/${share.shareId}/terminalize`;
    expect((await app.request(`/shares/${share.shareId}`)).status).toBe(404);
    const first = await app.request(path, post({ schema: 1, request: share, revokeToken: token }));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ schema: 1, shareId: share.shareId, expiresAt, requestSha256: digest(share), terminal: true });
    expect((await app.request("/shares", post(share))).status).toBe(409);
    expect((await app.request(path, post({ schema: 1, request: share, revokeToken: token }))).status).toBe(200);
    expect((await app.request(path, post({ schema: 1, request: { ...share, envelope: { ...share.envelope, ciphertext: Buffer.alloc(64, 9).toString("base64url") } }, revokeToken: token }))).status).toBe(409);
    expect((await app.request(`/shares/${share.shareId}`)).status).toBe(410);
  });

  it("replays a committed share create only for the exact owner, envelope, expiry and capability hash", async () => {
    const app = ownedRelayApp({ now: () => start });
    expect((await app.request("/shares", post(share))).status).toBe(201);
    expect((await app.request("/shares", post(share))).status).toBe(200);
    expect((await app.request("/shares", post({ ...share, expiresAt: "2026-09-15T12:00:00.000Z" }))).status).toBe(409);
  });

  it("requires authenticated origin-bound authority for terminal allocations and rejects the wrong path identity", async () => {
    const closed = createApp({ intakeRelay: new MemoryIntakeRelayStore({ now: () => start }), now: () => start });
    expect((await closed.request(`/intake/forms/${form.formId}/terminalize`, post(form))).status).toBe(401);
    expect((await closed.request(`/shares/${share.shareId}/terminalize`, post({ schema: 1, request: share, revokeToken: token }))).status).toBe(401);
    const app = ownedRelayApp({ intakeRelay: new MemoryIntakeRelayStore({ now: () => start }), now: () => start });
    expect((await app.request("/intake/forms/form_bcdefghijklmnopqrstuvwxyza/terminalize", post(form))).status).toBe(400);
    expect((await app.request(`/shares/${share.shareId}/terminalize`, { ...post({ schema: 1, request: share, revokeToken: token }), headers: { "content-type": "application/json", origin: "https://unconfigured.example" } })).status).toBe(403);
  });

  it("keeps exact owner/request identity across network-source changes; an IP quota label is not owner authority", async () => {
    const app = ownedRelayApp({ intakeRelay: new MemoryIntakeRelayStore({ now: () => start }), now: () => start });
    const send = (path: string, address: string) => app.request(path, { ...post(form), headers: { "content-type": "application/json", "x-real-ip": address } });
    expect((await send("/intake/forms", "192.0.2.1")).status).toBe(201);
    expect((await send("/intake/forms", "192.0.2.2")).status).toBe(200);
    expect((await send(`/intake/forms/${form.formId}/terminalize`, "192.0.2.3")).status).toBe(200);
    expect((await send("/intake/forms", "192.0.2.1")).status).toBe(409);
  });

  it("acknowledges expired immutable requests only when late arrivals can no longer publish", async () => {
    let at = start;
    const relay = new MemoryIntakeRelayStore({ now: () => at });
    const app = ownedRelayApp({ intakeRelay: relay, now: () => at });
    at = Date.parse(expiresAt);
    expect((await app.request(`/intake/forms/${form.formId}/terminalize`, post(form))).status).toBe(200);
    expect((await app.request(`/shares/${share.shareId}/terminalize`, post({ schema: 1, request: share, revokeToken: token }))).status).toBe(200);
    expect((await app.request("/intake/forms", post(form))).status).toBe(400);
    expect((await app.request("/shares", post(share))).status).toBe(400);
  });
});
