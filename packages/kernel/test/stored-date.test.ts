import { describe, expect, it } from "vitest";
import type { RegColumn } from "../src/registry";
import { coerceValue } from "../src/rows";
import { parseStoredDateValue } from "../src/stored-date";

const dateColumn = { type: "date" } as RegColumn;

const accepted = [
  "2026-09-06",
  "2026-09-06T09:30",
  "2026-09-06T09:30Z",
  "2026-09-06T09:30+05:45",
  "2026-09-06T09:30:00",
  "2026-09-06T09:30:00.1",
  "2026-09-06T09:30:00.12Z",
  "2026-09-06T09:30:00.123-04:00",
  "2026-09-06T24:00",
  "2026-09-06T24:00Z",
  "2026-09-06T24:00:00.000+00:00",
  "0000-01-01T00:00",
  "0099-12-31T24:00Z",
] as const;

const rejected = [
  "2026-02-30",
  "2026-09-06T24:01",
  "2026-09-06T24:00:01",
  "2026-09-06T24:00:00.001Z",
  "2026-09-06T09:30:00.1234Z",
  "2026-09-06 09:30",
  "9999-12-31T24:00Z",
] as const;

describe("stored date contract", () => {
  it("matches row coercion for every accepted form", () => {
    for (const value of accepted) {
      expect(parseStoredDateValue(value)).not.toBeNull();
      expect(coerceValue("records", dateColumn, value)).toBe(value);
    }
  });

  it("matches row coercion for every rejected form", () => {
    for (const value of rejected) {
      expect(parseStoredDateValue(value)).toBeNull();
      expect(() => coerceValue("records", dateColumn, value)).toThrow();
    }
  });

  it("normalizes end-of-day without changing the stored row value", () => {
    expect(parseStoredDateValue("2026-09-06T24:00")).toMatchObject({
      kind: "wall_time",
      parts: { year: 2026, month: 9, day: 7, hour: 0, minute: 0 },
    });
    expect(parseStoredDateValue("2026-09-06T24:00Z")).toMatchObject({
      kind: "instant",
      instant: "2026-09-07T00:00:00.000Z",
    });
  });
});
