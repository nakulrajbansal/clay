import { ClayError } from "./errors";

const INT64 = /^(?:0|-?[1-9][0-9]{0,18})$/;
const INT64_MIN = -9_223_372_036_854_775_808n;
const INT64_MAX = 9_223_372_036_854_775_807n;
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function invalid(): ClayError {
  return new ClayError("E_STATE_DIGEST_INVALID", "canonical state key component is invalid");
}

function base64url(bytes: Uint8Array): string {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const first = bytes[offset]!;
    const hasSecond = offset + 1 < bytes.length;
    const hasThird = offset + 2 < bytes.length;
    const second = hasSecond ? bytes[offset + 1]! : 0;
    const third = hasThird ? bytes[offset + 2]! : 0;
    result += BASE64URL[first >>> 2]!;
    result += BASE64URL[((first & 3) << 4) | (second >>> 4)]!;
    if (hasSecond) result += BASE64URL[((second & 15) << 2) | (third >>> 6)]!;
    if (hasThird) result += BASE64URL[third & 63]!;
  }
  return result;
}

export function canonicalTextKeyV1(value: string): string {
  if (typeof value !== "string") throw invalid();
  const bytes = encoder.encode(value);
  if (bytes.length > 512) throw invalid();
  try {
    if (decoder.decode(bytes) !== value) throw invalid();
  } catch {
    throw invalid();
  }
  return `t:${base64url(bytes)}`;
}

export function canonicalIntegerKeyV1(value: string): string {
  if (!INT64.test(value)) throw invalid();
  const parsed = BigInt(value);
  if (parsed < INT64_MIN || parsed > INT64_MAX || parsed.toString() !== value) throw invalid();
  return `i:${value}`;
}
