import type { ImportDateRule, ImportNumberRule } from "./import-contracts";

export type ReleaseCDateResult =
  | { ok: true; canonical: string }
  | { ok: false; reason: "unsupported_format" | "invalid_calendar_date" };

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1 || year > 9_999 || month < 1 || month > 12 || day < 1) return false;
  const monthLengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= monthLengths[month - 1]!;
}

function canonicalDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** C-FR-052 component parser; intentionally contains no host date calls. */
export function parseReleaseCDate(value: string, rule: ImportDateRule): ReleaseCDateResult {
  let year: number;
  let month: number;
  let day: number;
  if (rule.kind === "iso") {
    const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value);
    if (!match) return { ok: false, reason: "unsupported_format" };
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else {
    const parts = value.split(rule.separator);
    if (parts.length !== 3 || !/^[0-9]{1,2}$/.test(parts[0]!)
        || !/^[0-9]{1,2}$/.test(parts[1]!) || !/^[0-9]{4}$/.test(parts[2]!))
      return { ok: false, reason: "unsupported_format" };
    year = Number(parts[2]);
    const first = Number(parts[0]);
    const second = Number(parts[1]);
    month = rule.order === "mdy" ? first : second;
    day = rule.order === "mdy" ? second : first;
  }
  if (!validCalendarDate(year, month, day))
    return { ok: false, reason: "invalid_calendar_date" };
  return { ok: true, canonical: canonicalDate(year, month, day) };
}

export type ReleaseCNumberResult =
  | {
      ok: true;
      canonical: string;
      value: number;
      significantDigits: number;
      warning: "leading_zero_identifier" | null;
    }
  | {
      ok: false;
      reason: "unsupported_format" | "more_than_15_significant_digits"
        | "non_finite" | "percent_out_of_range";
    };

function unsignedNumberBody(value: string, rule: ImportNumberRule): string | null {
  if (rule.affix?.position === "prefix") {
    if (!value.startsWith(rule.affix.symbol)) return null;
    value = value.slice(rule.affix.symbol.length);
  } else if (rule.affix?.position === "suffix") {
    if (!value.endsWith(rule.affix.symbol)) return null;
    value = value.slice(0, -rule.affix.symbol.length);
  }
  if (rule.grammar === "ungrouped_dot_decimal")
    return /^(?:[0-9]+)(?:\.[0-9]+)?$/.test(value) ? value : null;
  if (rule.grammar === "comma_grouped_dot_decimal")
    return /^[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?$/.test(value)
      ? value.replaceAll(",", "") : null;
  return /^[0-9]{1,3}(?:\.[0-9]{3})+(?:,[0-9]+)?$/.test(value)
    ? value.replaceAll(".", "").replace(",", ".") : null;
}

/** Parse one value under the explicitly selected whole-column grammar. */
export function parseReleaseCNumber(
  input: string,
  rule: ImportNumberRule,
): ReleaseCNumberResult {
  let value = input;
  let sign = "";
  if (value.startsWith("+") || value.startsWith("-")) {
    sign = value[0]!;
    value = value.slice(1);
  }
  const body = unsignedNumberBody(value, rule);
  if (body === null) return { ok: false, reason: "unsupported_format" };
  const digits = body.replace(".", "").replace(/^0+/, "");
  const significantDigits = digits.length === 0 ? 1 : digits.length;
  if (significantDigits > 15)
    return { ok: false, reason: "more_than_15_significant_digits" };
  const signedCanonical = `${sign === "-" ? "-" : ""}${body}`;
  let numberValue = Number(signedCanonical);
  if (!Number.isFinite(numberValue)) return { ok: false, reason: "non_finite" };
  if (rule.percentScale === "zero_to_one" && (numberValue < 0 || numberValue > 1))
    return { ok: false, reason: "percent_out_of_range" };
  if (rule.percentScale === "zero_to_hundred") {
    if (numberValue < 0 || numberValue > 100)
      return { ok: false, reason: "percent_out_of_range" };
    numberValue /= 100;
  }
  const integerPart = body.split(".")[0]!;
  const warning = integerPart.length > 1 && integerPart.startsWith("0")
    ? "leading_zero_identifier" as const : null;
  return {
    ok: true,
    canonical: signedCanonical,
    value: numberValue,
    significantDigits,
    warning,
  };
}
