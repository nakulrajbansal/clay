import { ClayError } from "./errors";
import { sha256HexSync } from "./state-digest";

const KIT_PREFIX = "CLAY RECOVERY KIT 1\n";
const KIT_FORMAT = "clay-recovery-kit";
const MAX_KIT_BYTES = 1_024;
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const byteSlice = Uint8Array.prototype.slice;

export interface BackupTrustMaterialV1 {
  keyId: Uint8Array;
  seriesId: Uint8Array;
  backupTrustKey: Uint8Array;
}

export type SecureRandomFill = (target: Uint8Array) => void;
export type BackupTrustEnrollmentStatus =
  | "needs_export"
  | "needs_test_import"
  | "ready"
  | "destroyed";

function invalid(message: string): ClayError {
  return new ClayError("E_VALIDATION", `Recovery Kit is invalid: ${message}`);
}

function isPlainBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array
    && Object.getPrototypeOf(value) === Uint8Array.prototype
    && value.buffer instanceof ArrayBuffer;
}

function copyBytes(value: Uint8Array): Uint8Array {
  return byteSlice.call(value);
}

function nonzero(value: Uint8Array): boolean {
  let combined = 0;
  for (const byte of value) combined |= byte;
  return combined !== 0;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index++)
    difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function checkedBytes(value: unknown, label: string, length: number): Uint8Array {
  if (!isPlainBytes(value) || value.byteLength !== length)
    throw invalid(`${label} must contain exactly ${length} bytes`);
  const copy = copyBytes(value);
  if (!nonzero(copy)) {
    copy.fill(0);
    throw invalid(`${label} lacks secure random entropy`);
  }
  return copy;
}

function snapshotMaterial(value: unknown): BackupTrustMaterialV1 {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    throw invalid("key material must be a plain object");
  const names = ["keyId", "seriesId", "backupTrustKey"] as const;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== names.length || names.some(name => !ownKeys.includes(name)))
    throw invalid("key material fields are incomplete or unknown");
  const captured = new Map<string, unknown>();
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !("value" in descriptor))
      throw invalid("key material accessors are not accepted");
    captured.set(name, descriptor.value);
  }
  const material: BackupTrustMaterialV1 = {
    keyId: checkedBytes(captured.get("keyId"), "key id", 16),
    seriesId: checkedBytes(captured.get("seriesId"), "backup series id", 16),
    backupTrustKey: checkedBytes(captured.get("backupTrustKey"), "Backup Trust Key", 32),
  };
  if (bytesEqual(material.keyId, material.seriesId)) {
    destroyMaterial(material);
    throw invalid("key id and backup series id must be independently generated");
  }
  return material;
}

function destroyMaterial(material: BackupTrustMaterialV1): void {
  material.keyId.fill(0);
  material.seriesId.fill(0);
  material.backupTrustKey.fill(0);
}

function copyMaterial(material: BackupTrustMaterialV1): BackupTrustMaterialV1 {
  return {
    keyId: copyBytes(material.keyId),
    seriesId: copyBytes(material.seriesId),
    backupTrustKey: copyBytes(material.backupTrustKey),
  };
}

function materialEquals(left: BackupTrustMaterialV1, right: BackupTrustMaterialV1): boolean {
  return bytesEqual(left.keyId, right.keyId)
    && bytesEqual(left.seriesId, right.seriesId)
    && bytesEqual(left.backupTrustKey, right.backupTrustKey);
}

function encodeBase64Url(value: Uint8Array): string {
  let output = "";
  let bits = 0;
  let accumulator = 0;
  for (const byte of value) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      output += BASE64URL[(accumulator >>> bits) & 0x3f];
    }
  }
  if (bits > 0) output += BASE64URL[(accumulator << (6 - bits)) & 0x3f];
  return output;
}

function decodeBase64Url(value: unknown, label: string, length: number): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value))
    throw invalid(`${label} is not canonical base64url`);
  const output: number[] = [];
  let bits = 0;
  let accumulator = 0;
  for (const character of value) {
    const index = BASE64URL.indexOf(character);
    if (index < 0) throw invalid(`${label} is not canonical base64url`);
    accumulator = (accumulator << 6) | index;
    bits += 6;
    while (bits >= 8) {
      bits -= 8;
      output.push((accumulator >>> bits) & 0xff);
    }
  }
  if (bits > 0 && (accumulator & ((1 << bits) - 1)) !== 0)
    throw invalid(`${label} has nonzero base64url padding bits`);
  const decoded = new Uint8Array(output);
  if (decoded.byteLength !== length || encodeBase64Url(decoded) !== value)
    throw invalid(`${label} has the wrong length or noncanonical encoding`);
  return decoded;
}

function canonicalBase(material: BackupTrustMaterialV1): string {
  return JSON.stringify({
    format: KIT_FORMAT,
    version: 1,
    key_id: encodeBase64Url(material.keyId),
    backup_series_id: encodeBase64Url(material.seriesId),
    backup_trust_key: encodeBase64Url(material.backupTrustKey),
  });
}

function kitChecksum(material: BackupTrustMaterialV1): string {
  return `sha256:${sha256HexSync(encoder.encode(KIT_PREFIX + canonicalBase(material)))}`;
}

function canonicalKit(material: BackupTrustMaterialV1): string {
  return KIT_PREFIX + JSON.stringify({
    format: KIT_FORMAT,
    version: 1,
    key_id: encodeBase64Url(material.keyId),
    backup_series_id: encodeBase64Url(material.seriesId),
    backup_trust_key: encodeBase64Url(material.backupTrustKey),
    checksum: kitChecksum(material),
  });
}

export function encodeRecoveryKitV1(input: BackupTrustMaterialV1): Uint8Array {
  const material = snapshotMaterial(input);
  try {
    return encoder.encode(canonicalKit(material));
  } finally {
    destroyMaterial(material);
  }
}

export function decodeRecoveryKitV1(input: Uint8Array): BackupTrustMaterialV1 {
  if (!isPlainBytes(input) || input.byteLength === 0 || input.byteLength > MAX_KIT_BYTES)
    throw invalid("file must be a nonempty plain byte array under 1 KiB");
  const snapshot = copyBytes(input);
  let text: string;
  try {
    text = decoder.decode(snapshot);
  } catch {
    throw invalid("file is not valid UTF-8");
  } finally {
    snapshot.fill(0);
  }
  if (!text.startsWith(KIT_PREFIX)) throw invalid("versioned file header is missing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(KIT_PREFIX.length)) as unknown;
  } catch {
    throw invalid("body is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.getPrototypeOf(parsed) !== Object.prototype)
    throw invalid("body must be a plain object");
  const record = parsed as Record<string, unknown>;
  const names = [
    "format", "version", "key_id", "backup_series_id", "backup_trust_key", "checksum",
  ];
  if (Reflect.ownKeys(record).length !== names.length || names.some(name => !(name in record)))
    throw invalid("body fields are incomplete or unknown");
  if (record.format !== KIT_FORMAT || record.version !== 1)
    throw invalid("format or version is unsupported");
  if (typeof record.checksum !== "string" || !/^sha256:[0-9a-f]{64}$/.test(record.checksum))
    throw invalid("checksum is malformed");
  const material = snapshotMaterial({
    keyId: decodeBase64Url(record.key_id, "key id", 16),
    seriesId: decodeBase64Url(record.backup_series_id, "backup series id", 16),
    backupTrustKey: decodeBase64Url(record.backup_trust_key, "Backup Trust Key", 32),
  });
  if (text !== canonicalKit(material)) {
    destroyMaterial(material);
    throw invalid("file is not canonical or its checksum does not match");
  }
  return material;
}

function defaultSecureRandomFill(target: Uint8Array): void {
  const source = (globalThis as unknown as {
    crypto?: { getRandomValues<T extends Uint8Array>(value: T): T };
  }).crypto;
  if (!source?.getRandomValues)
    throw new ClayError("E_INTERNAL", "secure random generation is unavailable");
  source.getRandomValues(target);
}

export function generateBackupTrustMaterialV1(
  fill: SecureRandomFill = defaultSecureRandomFill,
): BackupTrustMaterialV1 {
  if (typeof fill !== "function") throw invalid("secure random source is unavailable");
  const entropy = new Uint8Array(64);
  try {
    fill(entropy);
    return snapshotMaterial({
      backupTrustKey: copyBytes(entropy.subarray(0, 32)),
      keyId: copyBytes(entropy.subarray(32, 48)),
      seriesId: copyBytes(entropy.subarray(48, 64)),
    });
  } catch (error) {
    if (error instanceof ClayError) throw error;
    throw new ClayError("E_INTERNAL", "secure random generation failed");
  } finally {
    entropy.fill(0);
  }
}

export class BackupTrustEnrollment {
  readonly #material: BackupTrustMaterialV1;
  #exportedDigest: string | null = null;
  #ready = false;
  #destroyed = false;

  constructor(input: BackupTrustMaterialV1) {
    this.#material = snapshotMaterial(input);
  }

  status(): BackupTrustEnrollmentStatus {
    if (this.#destroyed) return "destroyed";
    if (this.#ready) return "ready";
    return this.#exportedDigest === null ? "needs_export" : "needs_test_import";
  }

  recoveryKitBytes(): Uint8Array {
    this.#assertLive();
    return encodeRecoveryKitV1(this.#material);
  }

  recordRecoveryKitExported(bytes: Uint8Array): void {
    this.#assertLive();
    const imported = decodeRecoveryKitV1(bytes);
    try {
      if (!materialEquals(this.#material, imported))
        throw invalid("exported kit does not contain this Backup Trust Key");
      this.#exportedDigest = sha256HexSync(bytes);
      this.#ready = false;
    } finally {
      destroyMaterial(imported);
    }
  }

  confirmRecoveryKitImport(bytes: Uint8Array): void {
    this.#assertLive();
    if (this.#exportedDigest === null)
      throw invalid("Recovery Kit must be exported before test-import");
    const imported = decodeRecoveryKitV1(bytes);
    try {
      if (sha256HexSync(bytes) !== this.#exportedDigest
          || !materialEquals(this.#material, imported))
        throw invalid("test-import does not match the exact exported Recovery Kit");
      this.#ready = true;
    } finally {
      destroyMaterial(imported);
    }
  }

  materialForAutomaticBackup(): BackupTrustMaterialV1 {
    this.#assertLive();
    if (!this.#ready)
      throw invalid("Recovery Kit export and test-import must complete before automatic backup");
    return copyMaterial(this.#material);
  }

  destroy(): void {
    if (this.#destroyed) return;
    destroyMaterial(this.#material);
    this.#exportedDigest = null;
    this.#ready = false;
    this.#destroyed = true;
  }

  #assertLive(): void {
    if (this.#destroyed) throw invalid("enrollment was destroyed");
  }
}
