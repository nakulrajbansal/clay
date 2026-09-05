import { describe, expect, it } from "vitest";
import { ClayError } from "../src/index";
import { canonicalIntegerKeyV1, canonicalTextKeyV1 } from "../src/state-key";

function expectStateError(run: () => unknown): void {
  let thrown: unknown;
  try { run(); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(ClayError);
  expect((thrown as ClayError).code).toBe("E_STATE_DIGEST_INVALID");
}

describe("canonical state-key components", () => {
  it("encodes exact UTF-8 bytes as unpadded base64url", () => {
    expect(canonicalTextKeyV1("")).toBe("t:");
    expect(canonicalTextKeyV1("hello")).toBe("t:aGVsbG8");
    expect(canonicalTextKeyV1("✓")).toBe("t:4pyT");
    expect(canonicalTextKeyV1("\u0000/+")).toBe("t:AC8r");
    expect(canonicalTextKeyV1("hello")).not.toMatch(/[+=/]/);
  });

  it("encodes only canonical signed int64 decimal", () => {
    expect(canonicalIntegerKeyV1("0")).toBe("i:0");
    expect(canonicalIntegerKeyV1("-9223372036854775808")).toBe("i:-9223372036854775808");
    expect(canonicalIntegerKeyV1("9223372036854775807")).toBe("i:9223372036854775807");
    for (const value of ["-0", "+1", "01", "9223372036854775808"])
      expectStateError(() => canonicalIntegerKeyV1(value));
  });

  it("rejects lossy UTF-16 input and components above the bounded key budget", () => {
    expectStateError(() => canonicalTextKeyV1("\ud800"));
    expectStateError(() => canonicalTextKeyV1("x".repeat(700)));
  });
});
