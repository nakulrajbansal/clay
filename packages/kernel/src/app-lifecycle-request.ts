import { AppInstanceId, RequestId } from "@clay/schema/standalone/index";
import { ClayError } from "./errors";
import { sha256HexSync } from "./state-digest";
import { captureStrictJson } from "./strict-json-capture";

const MAX_CAPTURE_BYTES = 2_000_000;
const DISPLAY_NAME = /^\S(?:.{0,38}\S)?$/s;
const SHELL_ID = /^[a-z0-9_-]{1,64}$/;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const encoder = new TextEncoder();

/** Includes binding/request identities, punctuation, and every nested UTF-8 byte. */
export function captureAppImportRequest(input: unknown): unknown {
  return captureStrictJson(input, [10, 500_100, 1_000_000, MAX_CAPTURE_BYTES, 5_000, 128, 128, true, true,
    () => { throw invalid("import request exceeds 2,000,000 UTF-8 bytes or is not bounded plain data"); }]);
}

type LifecycleBase = { requestId: string };
export type AppLifecycleRequest =
  | (LifecycleBase & { kind: "create"; displayName: string; shellId: string })
  | (LifecycleBase & { kind: "fork" })
  | (LifecycleBase & { kind: "switch" | "delete"; appInstanceId: string })
  | (LifecycleBase & {
    kind: "rename";
    appInstanceId: string;
    displayName: string;
    shellId: string | null;
  });

class AggregateCaptureBudget {
  #used = 0;

  take(value: string): void {
    this.#used += encoder.encode(value).byteLength;
    if (this.#used > MAX_CAPTURE_BYTES)
      throw invalid("lifecycle request exceeds the aggregate capture budget");
  }
}

function invalid(message: string): ClayError {
  return new ClayError("E_CATALOG_UNAVAILABLE", message);
}

function plainDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  budget: AggregateCaptureBudget,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw invalid("lifecycle request must be a plain data record");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw invalid("lifecycle request must be a plain data record");
  const keys = Reflect.ownKeys(value);
  const expected = [...expectedKeys].sort();
  if (keys.some(key => typeof key !== "string")
      || keys.length !== expected.length
      || (keys as string[]).slice().sort().some((key, index) => key !== expected[index]))
    throw invalid("lifecycle request has unknown fields");
  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  budget.take("{");
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true)
      throw invalid("lifecycle request field is not plain data");
    budget.take(key);
    const field = descriptor.value;
    if (typeof field === "string") budget.take(field);
    else if (field === null) budget.take("null");
    else throw invalid("lifecycle request field type is invalid");
    captured[key] = field;
  }
  budget.take("}");
  return captured;
}

function expectedKeys(kind: string): readonly string[] {
  switch (kind) {
    case "create": return ["kind", "requestId", "displayName", "shellId"];
    case "fork": return ["kind", "requestId"];
    case "switch":
    case "delete": return ["kind", "requestId", "appInstanceId"];
    case "rename": return ["kind", "requestId", "appInstanceId", "displayName", "shellId"];
    default: throw invalid("lifecycle request kind is invalid");
  }
}

export function captureAppLifecycleRequest(value: unknown): AppLifecycleRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw invalid("lifecycle request must be a plain data record");
  const kindDescriptor = Object.getOwnPropertyDescriptor(value, "kind");
  if (!kindDescriptor || !("value" in kindDescriptor)
      || kindDescriptor.enumerable !== true || typeof kindDescriptor.value !== "string")
    throw invalid("lifecycle request kind is not plain data");
  const kind = kindDescriptor.value;
  const record = plainDataRecord(value, expectedKeys(kind), new AggregateCaptureBudget());
  const requestId = RequestId.safeParse(record.requestId);
  if (!requestId.success) throw invalid("lifecycle request identity is invalid");
  if (kind === "create") {
    if (typeof record.displayName !== "string" || !DISPLAY_NAME.test(record.displayName)
        || record.displayName.length > 40
        || typeof record.shellId !== "string" || !SHELL_ID.test(record.shellId))
      throw invalid("lifecycle app metadata is invalid");
    return { kind, requestId: requestId.data,
      displayName: record.displayName, shellId: record.shellId };
  }
  if (kind === "fork") return { kind, requestId: requestId.data };
  const appInstanceId = AppInstanceId.safeParse(record.appInstanceId);
  if (!appInstanceId.success) throw invalid("lifecycle app identity is invalid");
  if (kind === "switch" || kind === "delete")
    return { kind, requestId: requestId.data, appInstanceId: appInstanceId.data };
  if (kind === "rename") {
    if (typeof record.displayName !== "string" || !DISPLAY_NAME.test(record.displayName)
        || record.displayName.length > 40
        || (record.shellId !== null
          && (typeof record.shellId !== "string" || !SHELL_ID.test(record.shellId))))
      throw invalid("lifecycle app metadata is invalid");
    return {
      kind,
      requestId: requestId.data,
      appInstanceId: appInstanceId.data,
      displayName: record.displayName,
      shellId: record.shellId as string | null,
    };
  }
  throw invalid("lifecycle request kind is invalid");
}

export function lifecycleRequestSha256(request: AppLifecycleRequest): string {
  return `sha256:${sha256HexSync(encoder.encode(JSON.stringify(request)))}`;
}

export function deriveLifecycleId(
  prefix: "app" | "gen" | "ns" | "op" | "job",
  authorityIncarnationId: string,
  requestId: string,
  purpose: string,
): string {
  const digest = sha256HexSync(encoder.encode(
    `clay-app-lifecycle-v1\u0000${authorityIncarnationId}\u0000${requestId}\u0000${purpose}`,
  ));
  const bytes = new Uint8Array(17);
  for (let index = 0; index < bytes.length; index++)
    bytes[index] = Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16);
  let bits = 0;
  let value = 0;
  let encoded = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && encoded.length < 26) {
      bits -= 5;
      encoded += BASE32[(value >>> bits) & 31];
      value &= (1 << bits) - 1;
    }
  }
  if (encoded.length !== 26) throw invalid("lifecycle identity derivation failed");
  return `${prefix}_${encoded}`;
}
