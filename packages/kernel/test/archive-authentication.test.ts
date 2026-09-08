import { describe, expect, it } from "vitest";
import {
  CLAY_ARCHIVE_CONTENT_TYPE,
  hmacSha256ChunksSync,
  inspectAuthenticatedArchiveV5Header,
  sealAuthenticatedArchiveV5,
  verifyAuthenticatedArchiveV5,
  verifyAuthenticatedArchiveV5Owned,
  type AuthenticatedArchiveHeaderV1,
} from "../src/archive-authentication";

const fromHex = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

const key = new Uint8Array(Array.from({ length: 32 }, (_, index) => index));
const header: AuthenticatedArchiveHeaderV1 = {
  authenticationVersion: 1,
  archiveFormat: 5,
  contentType: "application/vnd.clay.archive+zip",
  keyId: new Uint8Array(Array.from({ length: 16 }, (_, index) => 0x10 + index)),
  seriesId: new Uint8Array(Array.from({ length: 16 }, (_, index) => 0x20 + index)),
  generation: 1n,
};
const payload = new TextEncoder().encode("abc");
const expectedEnvelope = "d1845876a8010502843a000100003a000100013a000100023a000100030378206170706c69636174696f6e2f766e642e636c61792e617263686976652b7a69700450101112131415161718191a1b1c1d1e1f3a00010000013a00010001053a0001000250202122232425262728292a2b2c2d2e2f3a0001000301a0436162635820f8d706b8932e42e5e3555de61918543ea45e855adf4d5ef6cedf227f7462a6d6";

describe("authenticated format-5 COSE_Mac0 envelope", () => {
  it("matches an independently generated deterministic HMAC 256/256 vector", () => {
    expect(CLAY_ARCHIVE_CONTENT_TYPE).toBe("application/vnd.clay.archive+zip");
    expect(toHex(sealAuthenticatedArchiveV5(payload, key, header))).toBe(expectedEnvelope);
  });

  it("implements the RFC 4231 HMAC-SHA-256 test vector across chunks", () => {
    const actual = hmacSha256ChunksSync(
      new Uint8Array(20).fill(0x0b),
      [new TextEncoder().encode("Hi "), new TextEncoder().encode("There")],
    );
    expect(toHex(actual)).toBe("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
  });

  it("strictly inspects only the unauthenticated key-selection header", () => {
    const envelope = sealAuthenticatedArchiveV5(payload, key, header);
    const inspected = inspectAuthenticatedArchiveV5Header(envelope);
    expect(inspected).toEqual(header);
    inspected.keyId.fill(0);
    expect(inspectAuthenticatedArchiveV5Header(envelope).keyId).toEqual(header.keyId);
    const trailing = new Uint8Array(envelope.byteLength + 1);
    trailing.set(envelope);
    expect(() => inspectAuthenticatedArchiveV5Header(trailing)).toThrow(/trailing|framing/i);
  });

  it("selects the trusted key by an unauthenticated hint then returns copied authenticated bytes", () => {
    const envelope = sealAuthenticatedArchiveV5(payload, key, header);
    let observedKeyId = "";
    const verified = verifyAuthenticatedArchiveV5(envelope, hint => {
      observedKeyId = toHex(hint.keyId);
      expect(hint.seriesId).toEqual(header.seriesId);
      return key;
    });
    expect(observedKeyId).toBe(toHex(header.keyId));
    expect(verified.header).toEqual(header);
    expect(verified.payload).toEqual(payload);

    envelope.fill(0);
    expect(verified.payload).toEqual(payload);
    expect(verified.header.keyId).toEqual(header.keyId);
  });

  it("authenticates a transferred envelope over bounded views without cloning its payload", () => {
    const envelope = sealAuthenticatedArchiveV5(payload, key, header);
    const verified = verifyAuthenticatedArchiveV5Owned(envelope, () => key);
    expect(verified.payload.buffer).toBe(envelope.buffer);
    expect(verified.payload.byteOffset).toBeGreaterThan(envelope.byteOffset);
    expect(verified.payload).toEqual(payload);
  });

  it("rejects payload, protected-header, and tag tampering", () => {
    const envelope = sealAuthenticatedArchiveV5(payload, key, header);
    for (const index of [10, envelope.length - 35, envelope.length - 1]) {
      const tampered = envelope.slice();
      tampered[index] = tampered[index]! ^ 1;
      expect(() => verifyAuthenticatedArchiveV5(tampered, () => key)).toThrow(
        /invalid|authentication|protected header/i,
      );
    }
  });

  it("rejects an unknown key without returning payload bytes", () => {
    const envelope = sealAuthenticatedArchiveV5(payload, key, header);
    expect(() => verifyAuthenticatedArchiveV5(envelope, () => null)).toThrow(/trusted.*key/i);
  });

  it("rejects alternate framing, a nonempty unprotected map, and trailing bytes", () => {
    const canonical = fromHex(expectedEnvelope);
    const unprotectedOffset = 122;
    const payloadOffset = 123;
    expect(canonical[unprotectedOffset]).toBe(0xa0);
    expect(canonical[payloadOffset]).toBe(0x43);

    const nonempty = new Uint8Array(canonical.length + 2);
    nonempty.set(canonical.subarray(0, unprotectedOffset), 0);
    nonempty.set([0xa1, 0x01, 0x05], unprotectedOffset);
    nonempty.set(canonical.subarray(payloadOffset), unprotectedOffset + 3);
    expect(() => verifyAuthenticatedArchiveV5(nonempty, () => key)).toThrow(/unprotected|framing/i);

    const longPayloadLength = new Uint8Array(canonical.length + 1);
    longPayloadLength.set(canonical.subarray(0, payloadOffset), 0);
    longPayloadLength.set([0x58, 0x03], payloadOffset);
    longPayloadLength.set(canonical.subarray(payloadOffset + 1), payloadOffset + 2);
    expect(() => verifyAuthenticatedArchiveV5(longPayloadLength, () => key)).toThrow(/deterministic|framing/i);

    const trailing = new Uint8Array(canonical.length + 1);
    trailing.set(canonical);
    expect(() => verifyAuthenticatedArchiveV5(trailing, () => key)).toThrow(/trailing|framing/i);
  });

  it("rejects malformed key material and out-of-range headers", () => {
    expect(() => sealAuthenticatedArchiveV5(payload, new Uint8Array(31), header)).toThrow(/256-bit/i);
    expect(() => sealAuthenticatedArchiveV5(payload, key, { ...header, keyId: new Uint8Array(15) }))
      .toThrow(/key id/i);
    expect(() => sealAuthenticatedArchiveV5(payload, key, { ...header, seriesId: new Uint8Array(17) }))
      .toThrow(/series id/i);
    expect(() => sealAuthenticatedArchiveV5(payload, key, { ...header, generation: 1n << 64n }))
      .toThrow(/generation/i);
  });
});
