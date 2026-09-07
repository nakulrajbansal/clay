import type { AuthenticatedFormat5RestoreGrantV1 } from "@clay/schema/restore";
import { BackupAuthenticationV1 } from "@clay/schema/backup";
export type AuthenticatedFormat5RestoreGrant = AuthenticatedFormat5RestoreGrantV1;
export type { BackupFailureReasonCodeV1 as BackupFailureReasonCode } from "@clay/schema/backup";

const APP_ID = /^app_[a-z2-7]{26}$/;
const GENERATION_ID = /^gen_[a-z2-7]{26}$/;
const VALIDATION_ID = /^restoreval_[a-z2-7]{26}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const UINT64_MAX = 18_446_744_073_709_551_615n;

function exactDataRecord(input: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).length !== keys.length) return null;
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
    output[key] = descriptor.value;
  }
  return output;
}

function canonicalInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { return new Date(value).toISOString() === value; }
  catch { return false; }
}

function uint64(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(value)) return false;
  try { return BigInt(value) <= UINT64_MAX; }
  catch { return false; }
}

const matches = (pattern: RegExp, value: unknown): value is string =>
  typeof value === "string" && pattern.test(value);

const GRANT_KEYS = [
  "schema", "kind", "validationId", "archiveFormat", "cryptographicallyAuthenticated",
  "authentication", "archiveSha256", "archiveTarget", "preservedAppInstanceId",
  "destinationAppInstanceId", "installMode", "validatedAt",
] as const;
const TARGET_KEYS = [
  "appInstanceId", "activeGenerationId", "lineageEpoch", "protectionRevision",
  "digestSchema", "stateSha256",
] as const;
const AUTHENTICATION_KEYS = [
  "schema", "kind", "authenticationVersion", "keyId", "seriesId", "generation",
] as const;

/**
 * Presentation-boundary parser for a trusted worker grant. It copies only fixed
 * data properties and rejects accessors. The worker must still authenticate the
 * archive and enforce this grant again; this helper never validates archive bytes.
 */
export function parseAuthenticatedFormat5RestoreGrant(
  input: unknown,
): AuthenticatedFormat5RestoreGrant | null {
  const grant = exactDataRecord(input, GRANT_KEYS);
  if (!grant) return null;
  const target = exactDataRecord(grant.archiveTarget, TARGET_KEYS);
  const authentication = exactDataRecord(grant.authentication, AUTHENTICATION_KEYS);
  const parsedAuthentication = authentication
    ? BackupAuthenticationV1.safeParse(authentication)
    : null;
  if (!target || !parsedAuthentication?.success
      || grant.schema !== 1
      || grant.kind !== "authenticated_format5_restore_as_new"
      || !matches(VALIDATION_ID, grant.validationId)
      || grant.archiveFormat !== 5
      || grant.cryptographicallyAuthenticated !== true
      || !matches(SHA256, grant.archiveSha256)
      || !matches(APP_ID, target.appInstanceId)
      || !matches(GENERATION_ID, target.activeGenerationId)
      || !uint64(target.lineageEpoch)
      || !uint64(target.protectionRevision)
      || target.digestSchema !== 1
      || !matches(SHA256, target.stateSha256)
      || !matches(APP_ID, grant.preservedAppInstanceId)
      || !matches(APP_ID, grant.destinationAppInstanceId)
      || grant.destinationAppInstanceId === grant.preservedAppInstanceId
      || grant.installMode !== "new_app_only"
      || !canonicalInstant(grant.validatedAt)) return null;

  grant.archiveTarget = target;
  grant.authentication = parsedAuthentication.data;
  return grant as AuthenticatedFormat5RestoreGrant;
}
