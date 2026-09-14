import { ClayError } from "./errors";
import { PRODUCTION_MUTATION_PREFIX } from "./production-input-capture";
import { captureStrictJson, type StrictJsonCaptureBudget as CaptureBudget, type StrictJsonCapturePolicy } from "./strict-json-capture";
import type { ProductionResponseJson as JsonValue } from "./production-response-envelope";
const unavailable = (message: string) => new ClayError("E_CATALOG_UNAVAILABLE", message);

export const MAX_CAPTURE_BYTES = 2_000_000;
const PRODUCTION_CAPTURE_POLICY: StrictJsonCapturePolicy = [
  64, 100_000, 1_000_000, MAX_CAPTURE_BYTES, 10_000, 10_000, 128, true, true,
  reason => {
    if (reason < 5) throw unavailable(reason === 1
      ? PRODUCTION_MUTATION_PREFIX + "payload exceeds aggregate limits"
      : PRODUCTION_MUTATION_PREFIX + "payload exceeds limits");
    return invalidCapturedJson(reason);
  },
];

/** Same failure mapping for the three closed production capture budgets. */
export function invalidCapturedJson(reason: number): never {
  const messages = ["invalid JSON value", "invalid JSON value", "cyclic JSON value", "invalid array",
    "invalid array keys", "invalid array item", "invalid record", "invalid record property"];
  throw new Error(messages[reason - 5] ?? "invalid JSON value");
}

export function captureJsonValue(
  input: unknown,
  seen: WeakSet<object>,
  depth = 0,
  budget: CaptureBudget = { nodes: 0, bytes: 0 },
): JsonValue {
  return captureStrictJson(input, PRODUCTION_CAPTURE_POLICY, seen, budget, depth) as JsonValue;
}
