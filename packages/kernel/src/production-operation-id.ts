import { OperationId } from "@clay/schema";
import { ClayError } from "./errors";
import { sha256HexSync } from "./state-digest";

const AUTHORITY_ID = /^auth_[a-z2-7]{26}$/;
const REQUEST_ID = /^req_[a-z2-7]{26}$/;
const ROUTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const SAMPLE_PRODUCER_ROUTES = [
  "starter.seed",
  "samples.fill",
  "archive.restore.samples",
] as const;

export type SampleProducerRoute = typeof SAMPLE_PRODUCER_ROUTES[number];

function invalid(message: string): ClayError {
  return new ClayError("E_TARGET_AUTHORITY_INVALID", message);
}

function encodeOperationDigest(hex: string): string {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index++)
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  let bits = 0;
  let value = 0;
  let encoded = "";
  for (let index = 0; index < bytes.length && encoded.length < 26; index++) {
    value = (value << 8) | bytes[index]!;
    bits += 8;
    while (bits >= 5 && encoded.length < 26) {
      bits -= 5;
      encoded += ALPHABET[(value >>> bits) & 31];
      value &= (1 << bits) - 1;
    }
  }
  return OperationId.parse(`op_${encoded}`);
}

function validateInputs(authorityIncarnationId: string, requestId: string): void {
  if (!AUTHORITY_ID.test(authorityIncarnationId) || !REQUEST_ID.test(requestId))
    throw invalid("production operation identity inputs are invalid");
}

export function productionOperationIdV1(
  authorityIncarnationId: string,
  requestId: string,
): string {
  validateInputs(authorityIncarnationId, requestId);
  return encodeOperationDigest(sha256HexSync(new TextEncoder().encode(
    `clay-production-operation-v1\u0000${authorityIncarnationId}\u0000${requestId}`,
  )));
}

export function productionOperationIdV2(
  authorityIncarnationId: string,
  requestId: string,
  route: string,
): string {
  validateInputs(authorityIncarnationId, requestId);
  if (!ROUTE.test(route)) throw invalid("production operation route is invalid");
  return encodeOperationDigest(sha256HexSync(new TextEncoder().encode(
    `clay-production-operation-v2\u0000${authorityIncarnationId}\u0000${requestId}\u0000${route}`,
  )));
}

export function sampleProducerRouteForOperationId(
  authorityIncarnationId: string,
  requestId: string,
  operationId: string,
): SampleProducerRoute | null {
  let matched: SampleProducerRoute | null = null;
  for (const route of SAMPLE_PRODUCER_ROUTES) {
    if (productionOperationIdV2(authorityIncarnationId, requestId, route) !== operationId)
      continue;
    if (matched !== null)
      throw invalid("production operation identity matches multiple producer routes");
    matched = route;
  }
  return matched;
}
