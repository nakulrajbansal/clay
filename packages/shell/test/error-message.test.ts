import { expect, it } from "vitest";
import { errorMessage } from "../src/app/error-message";

it("preserves the former error conversion exactly, including thrown conversion and no extra reads", () => {
  const former = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
  for (const cause of [new Error("synthetic failure"), new Error(""), undefined, null, false, 0, NaN,
    12n, Symbol("synthetic"), "text", [], {}, { message: "not an Error" }]) {
    expect(errorMessage(cause)).toBe(former(cause));
  }
  let reads = 0;
  const synthetic = new Error(); Object.defineProperty(synthetic, "message", { get: () => { reads++; return "once"; } });
  expect(errorMessage(synthetic)).toBe("once"); expect(reads).toBe(1);
  const exception = new Error("conversion refused");
  const unprintable = { toString: () => { throw exception; } };
  expect(() => errorMessage(unprintable)).toThrow(exception);
  expect(() => former(unprintable)).toThrow(exception);
});
