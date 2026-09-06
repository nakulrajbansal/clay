import { describe, expect, it, vi } from "vitest";
import {
  ImportDateRuleSchema,
  ImportNumberRuleSchema,
} from "../src/import-contracts";
import {
  parseReleaseCDate,
  parseReleaseCNumber,
} from "../src/import-grammar";

describe("C-FR-052 date grammar", () => {
  it("parses exact Gregorian ISO dates without consulting host Date.parse", () => {
    const hostParse = vi.spyOn(Date, "parse").mockImplementation(() => {
      throw new Error("host parser must remain unreachable");
    });
    try {
      const rule = ImportDateRuleSchema.parse({ kind: "iso" });
      expect(parseReleaseCDate("2024-02-29", rule)).toEqual({
        ok: true, canonical: "2024-02-29",
      });
      expect(parseReleaseCDate("2023-02-29", rule)).toEqual({
        ok: false, reason: "invalid_calendar_date",
      });
      expect(parseReleaseCDate("0000-01-01", rule)).toEqual({
        ok: false, reason: "invalid_calendar_date",
      });
      expect(parseReleaseCDate("2026-2-03", rule)).toEqual({
        ok: false, reason: "unsupported_format",
      });
    } finally {
      hostParse.mockRestore();
    }
  });

  it("uses only the selected whole-column M/D or D/M order and separator", () => {
    const mdy = ImportDateRuleSchema.parse({
      kind: "ordered", order: "mdy", separator: "/",
    });
    const dmy = ImportDateRuleSchema.parse({
      kind: "ordered", order: "dmy", separator: "-",
    });
    expect(parseReleaseCDate("2/29/2024", mdy)).toEqual({
      ok: true, canonical: "2024-02-29",
    });
    expect(parseReleaseCDate("3/4/2026", mdy)).toEqual({
      ok: true, canonical: "2026-03-04",
    });
    expect(parseReleaseCDate("29-2-2024", dmy)).toEqual({
      ok: true, canonical: "2024-02-29",
    });
    expect(parseReleaseCDate("3-4-2026", dmy)).toEqual({
      ok: true, canonical: "2026-04-03",
    });
    for (const unsupported of ["2-29-2024", "02/29/24", "29 Feb 2024", "2/29-2024"])
      expect(parseReleaseCDate(unsupported, mdy)).toEqual({
        ok: false, reason: "unsupported_format",
      });
    expect(ImportDateRuleSchema.safeParse({ ...mdy, locale: "en-US" }).success).toBe(false);
  });
});

describe("C-FR-052 number grammar", () => {
  it("accepts only the selected ungrouped or strict grouping grammar", () => {
    const ungrouped = ImportNumberRuleSchema.parse({
      grammar: "ungrouped_dot_decimal", affix: null, percentScale: "none",
    });
    const commaGrouped = ImportNumberRuleSchema.parse({
      grammar: "comma_grouped_dot_decimal", affix: null, percentScale: "none",
    });
    const dotGrouped = ImportNumberRuleSchema.parse({
      grammar: "dot_grouped_comma_decimal", affix: null, percentScale: "none",
    });

    expect(parseReleaseCNumber("+1234.50", ungrouped)).toEqual({
      ok: true, canonical: "1234.50", value: 1234.5, significantDigits: 6,
      warning: null,
    });
    expect(parseReleaseCNumber("-1,234,567.50", commaGrouped)).toEqual({
      ok: true, canonical: "-1234567.50", value: -1234567.5, significantDigits: 9,
      warning: null,
    });
    expect(parseReleaseCNumber("+1.234.567,50", dotGrouped)).toEqual({
      ok: true, canonical: "1234567.50", value: 1234567.5, significantDigits: 9,
      warning: null,
    });
    for (const rejected of ["1,234.56", "1e3", " 123", "(123)", "1'234", "Infinity"])
      expect(parseReleaseCNumber(rejected, ungrouped)).toEqual({
        ok: false, reason: "unsupported_format",
      });
    for (const rejected of ["12,34.56", "1234.56"])
      expect(parseReleaseCNumber(rejected, commaGrouped)).toEqual({
        ok: false, reason: "unsupported_format",
      });
  });

  it("requires the selected fixed currency position and explicit percent scale", () => {
    const dollars = ImportNumberRuleSchema.parse({
      grammar: "comma_grouped_dot_decimal",
      affix: { symbol: "$", position: "prefix" },
      percentScale: "none",
    });
    const euros = ImportNumberRuleSchema.parse({
      grammar: "dot_grouped_comma_decimal",
      affix: { symbol: "€", position: "suffix" },
      percentScale: "none",
    });
    expect(parseReleaseCNumber("-$1,234.50", dollars)).toMatchObject({
      ok: true, canonical: "-1234.50", value: -1234.5,
    });
    expect(parseReleaseCNumber("-1.234,50€", euros)).toMatchObject({
      ok: true, canonical: "-1234.50", value: -1234.5,
    });
    for (const rejected of ["$-1,234.50", "-1,234.50$", "-£1,234.50", "-1,234.50"])
      expect(parseReleaseCNumber(rejected, dollars)).toEqual({
        ok: false, reason: "unsupported_format",
      });

    const zeroToHundred = ImportNumberRuleSchema.parse({
      grammar: "ungrouped_dot_decimal", affix: null, percentScale: "zero_to_hundred",
    });
    expect(parseReleaseCNumber("50", zeroToHundred)).toMatchObject({ ok: true, value: 0.5 });
    expect(parseReleaseCNumber("101", zeroToHundred)).toEqual({
      ok: false, reason: "percent_out_of_range",
    });
  });

  it("keeps leading-zero identifiers visible and blocks more than 15 significant digits", () => {
    const rule = ImportNumberRuleSchema.parse({
      grammar: "ungrouped_dot_decimal", affix: null, percentScale: "none",
    });
    expect(parseReleaseCNumber("000123", rule)).toEqual({
      ok: true,
      canonical: "000123",
      value: 123,
      significantDigits: 3,
      warning: "leading_zero_identifier",
    });
    expect(parseReleaseCNumber("123456789012345", rule)).toMatchObject({
      ok: true, canonical: "123456789012345", significantDigits: 15,
    });
    expect(parseReleaseCNumber("1234567890123456", rule)).toEqual({
      ok: false, reason: "more_than_15_significant_digits",
    });
  });
});
