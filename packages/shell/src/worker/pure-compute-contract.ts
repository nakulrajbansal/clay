import { ComputeRequestV1, ComputeReplyV1 } from "@clay/schema/standalone/pure-compute";
import { captureStrictJson } from "@clay/kernel/strict-json-capture";

export function computeInvalid(): never { throw new Error("Invalid starter computation"); }
function capture(value: unknown) {
  return captureStrictJson(value, [8, 100, 900_000, 1_100_000, 0, 8, 32, true, true, computeInvalid]);
}
export function captureComputeRequest(value: unknown): ComputeRequestV1 {
  const result = ComputeRequestV1.safeParse(capture(value));
  if (!result.success) return computeInvalid();
  return result.data;
}
export function captureComputeReply(value: unknown): ComputeReplyV1 {
  const result = ComputeReplyV1.safeParse(capture(value));
  if (!result.success) return computeInvalid();
  return result.data;
}

// Only used on owned, captured/generated JSON. No executable decoding.
export function canonicalSeedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSeedJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalSeedJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
