import { describe, expect, it } from "vitest";
import { isRecipientSharePathV1 } from "../src/share/route";

describe("recipient share entry route", () => {
  it("selects only an exact valid opaque share path", () => {
    expect(isRecipientSharePathV1("/share/shr_abcdefghijklmnopqrstuvwxyz")).toBe(true);
    expect(isRecipientSharePathV1("/share/../admin")).toBe(false);
    expect(isRecipientSharePathV1("/share/shr_abcdefghijklmnopqrstuvwxyz/edit")).toBe(false);
    expect(isRecipientSharePathV1("/shares/shr_abcdefghijklmnopqrstuvwxyz")).toBe(false);
    expect(isRecipientSharePathV1("/")).toBe(false);
  });
});
