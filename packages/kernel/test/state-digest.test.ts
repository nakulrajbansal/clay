import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256HexSync } from "../src/state-digest";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("bounded synchronous SHA-256", () => {
  it("matches standard SHA-256 vectors", () => {
    expect(sha256HexSync(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256HexSync(bytes("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256HexSync(bytes("The quick brown fox jumps over the lazy dog"))).toBe(
      "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592",
    );
  });

  it("matches an independent Node crypto oracle across block boundaries", () => {
    for (const size of [55, 56, 63, 64, 65, 255, 256, 257, 4096]) {
      const input = new Uint8Array(size);
      for (let index = 0; index < input.length; index++) input[index] = index % 251;
      expect(sha256HexSync(input)).toBe(createHash("sha256").update(input).digest("hex"));
    }
  });
});
