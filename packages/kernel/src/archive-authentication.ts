import { ClayError } from "./errors";
import { sha256ChunksBytesSync } from "./state-digest";

export const CLAY_ARCHIVE_CONTENT_TYPE = "application/vnd.clay.archive+zip";
export const MAX_AUTHENTICATED_ARCHIVE_PAYLOAD_BYTES = 384 * 1024 * 1024;
export const MAX_AUTHENTICATED_ARCHIVE_ENVELOPE_BYTES =
  MAX_AUTHENTICATED_ARCHIVE_PAYLOAD_BYTES + 512;

const COSE_MAC0_TAG = 17n;
const COSE_HMAC_256_256 = 5n;
const AUTHENTICATION_VERSION = 1n;
const ARCHIVE_FORMAT = 5n;
const LABEL_AUTHENTICATION_VERSION = -65537n;
const LABEL_ARCHIVE_FORMAT = -65538n;
const LABEL_BACKUP_SERIES_ID = -65539n;
const LABEL_BACKUP_GENERATION = -65540n;
const PRIVATE_LABELS = [
  LABEL_AUTHENTICATION_VERSION,
  LABEL_ARCHIVE_FORMAT,
  LABEL_BACKUP_SERIES_ID,
  LABEL_BACKUP_GENERATION,
] as const;
const MAX_UINT64 = (1n << 64n) - 1n;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const byteSlice = Uint8Array.prototype.slice;
const byteSubarray = Uint8Array.prototype.subarray;

export interface AuthenticatedArchiveHeaderV1 {
  authenticationVersion: 1;
  archiveFormat: 5;
  contentType: typeof CLAY_ARCHIVE_CONTENT_TYPE;
  keyId: Uint8Array;
  seriesId: Uint8Array;
  generation: bigint;
}

export interface AuthenticatedArchiveKeyHintV1 {
  readonly authenticationVersion: 1;
  readonly archiveFormat: 5;
  readonly contentType: typeof CLAY_ARCHIVE_CONTENT_TYPE;
  readonly keyId: Uint8Array;
  readonly seriesId: Uint8Array;
  readonly generation: bigint;
}

export type BackupTrustKeyResolver = (
  hint: AuthenticatedArchiveKeyHintV1,
) => Uint8Array | null;

export interface VerifiedAuthenticatedArchiveV5 {
  header: AuthenticatedArchiveHeaderV1;
  payload: Uint8Array;
}

function invalid(message: string): ClayError {
  return new ClayError("E_VALIDATION", `authenticated archive envelope is invalid: ${message}`);
}

function isPlainBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array
    && Object.getPrototypeOf(value) === Uint8Array.prototype
    && value.buffer instanceof ArrayBuffer;
}

function copyBytes(value: Uint8Array, start?: number, end?: number): Uint8Array {
  return byteSlice.call(value, start, end);
}

function viewBytes(value: Uint8Array, start: number, end: number): Uint8Array {
  return byteSubarray.call(value, start, end);
}

function checkedBytes(value: unknown, label: string, length?: number): Uint8Array {
  if (!isPlainBytes(value)) throw invalid(`${label} must be a plain byte array`);
  if (length !== undefined && value.byteLength !== length)
    throw invalid(`${label} must contain exactly ${length} bytes`);
  return copyBytes(value);
}

function checkedBackupTrustKey(value: unknown): Uint8Array {
  if (!isPlainBytes(value) || value.byteLength !== 32)
    throw invalid("Backup Trust Key must contain exactly 256-bit key material");
  return copyBytes(value);
}

function snapshotHeader(value: unknown): AuthenticatedArchiveHeaderV1 {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    throw invalid("protected header must be a plain object");
  const names = [
    "authenticationVersion", "archiveFormat", "contentType", "keyId", "seriesId", "generation",
  ] as const;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== names.length || names.some(name => !ownKeys.includes(name)))
    throw invalid("protected header fields are incomplete or unknown");
  const captured = new Map<string, unknown>();
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !("value" in descriptor))
      throw invalid("protected header accessors are not accepted");
    captured.set(name, descriptor.value);
  }
  if (captured.get("authenticationVersion") !== 1)
    throw invalid("authentication version must be 1");
  if (captured.get("archiveFormat") !== 5)
    throw invalid("archive format must be 5");
  if (captured.get("contentType") !== CLAY_ARCHIVE_CONTENT_TYPE)
    throw invalid("archive content type is unsupported");
  const generation = captured.get("generation");
  if (typeof generation !== "bigint" || generation < 1n || generation > MAX_UINT64)
    throw invalid("backup generation must be a positive uint64");
  return {
    authenticationVersion: 1,
    archiveFormat: 5,
    contentType: CLAY_ARCHIVE_CONTENT_TYPE,
    keyId: checkedBytes(captured.get("keyId"), "key id", 16),
    seriesId: checkedBytes(captured.get("seriesId"), "backup series id", 16),
    generation,
  };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let size = 0;
  for (const part of parts) {
    size += part.byteLength;
    if (!Number.isSafeInteger(size)) throw invalid("encoded length exceeds the safe integer range");
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function encodeHead(major: number, argument: bigint): Uint8Array {
  if (!Number.isInteger(major) || major < 0 || major > 7
      || argument < 0n || argument > MAX_UINT64)
    throw invalid("CBOR argument is out of range");
  if (argument < 24n) return new Uint8Array([(major << 5) | Number(argument)]);
  if (argument <= 0xffn) return new Uint8Array([(major << 5) | 24, Number(argument)]);
  const width = argument <= 0xffffn ? 2 : argument <= 0xffff_ffffn ? 4 : 8;
  const output = new Uint8Array(1 + width);
  output[0] = (major << 5) | (width === 2 ? 25 : width === 4 ? 26 : 27);
  let remaining = argument;
  for (let index = width; index > 0; index--) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return output;
}

function encodeInteger(value: bigint): Uint8Array {
  return value >= 0n ? encodeHead(0, value) : encodeHead(1, -1n - value);
}

function encodeBytesHeader(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0)
    throw invalid("byte string length is invalid");
  return encodeHead(2, BigInt(length));
}

function encodeBytes(value: Uint8Array): Uint8Array {
  return concat([encodeBytesHeader(value.byteLength), value]);
}

function encodeText(value: string): Uint8Array {
  const bytes = textEncoder.encode(value);
  return concat([encodeHead(3, BigInt(bytes.byteLength)), bytes]);
}

function encodeArray(values: readonly Uint8Array[]): Uint8Array {
  return concat([encodeHead(4, BigInt(values.length)), ...values]);
}

function bytewise(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index++) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

function encodeMap(entries: readonly (readonly [bigint, Uint8Array])[]): Uint8Array {
  const encoded = entries.map(([key, value]) => [encodeInteger(key), value] as const)
    .sort((left, right) => bytewise(left[0], right[0]));
  return concat([
    encodeHead(5, BigInt(encoded.length)),
    ...encoded.flatMap(([key, value]) => [key, value]),
  ]);
}

function encodeProtectedHeader(header: AuthenticatedArchiveHeaderV1): Uint8Array {
  return encodeMap([
    [1n, encodeInteger(COSE_HMAC_256_256)],
    [2n, encodeArray(PRIVATE_LABELS.map(encodeInteger))],
    [3n, encodeText(CLAY_ARCHIVE_CONTENT_TYPE)],
    [4n, encodeBytes(header.keyId)],
    [LABEL_AUTHENTICATION_VERSION, encodeInteger(AUTHENTICATION_VERSION)],
    [LABEL_ARCHIVE_FORMAT, encodeInteger(ARCHIVE_FORMAT)],
    [LABEL_BACKUP_SERIES_ID, encodeBytes(header.seriesId)],
    [LABEL_BACKUP_GENERATION, encodeInteger(header.generation)],
  ]);
}

function macStructureChunks(
  protectedHeader: Uint8Array,
  payload: Uint8Array,
): readonly Uint8Array[] {
  return [
    encodeHead(4, 4n),
    encodeText("MAC0"),
    encodeBytes(protectedHeader),
    encodeBytes(new Uint8Array()),
    encodeBytesHeader(payload.byteLength),
    payload,
  ];
}

export function hmacSha256ChunksSync(
  keyInput: Uint8Array,
  chunks: readonly Uint8Array[],
): Uint8Array {
  if (!isPlainBytes(keyInput) || keyInput.byteLength === 0)
    throw invalid("HMAC key must be a nonempty plain byte array");
  for (const chunk of chunks)
    if (!isPlainBytes(chunk)) throw invalid("HMAC input must contain plain byte arrays");

  const normalized = keyInput.byteLength > 64
    ? sha256ChunksBytesSync([keyInput])
    : copyBytes(keyInput);
  const block = new Uint8Array(64);
  block.set(normalized);
  const innerPad = new Uint8Array(64);
  const outerPad = new Uint8Array(64);
  for (let index = 0; index < 64; index++) {
    innerPad[index] = block[index]! ^ 0x36;
    outerPad[index] = block[index]! ^ 0x5c;
  }
  const inner = sha256ChunksBytesSync([innerPad, ...chunks]);
  const result = sha256ChunksBytesSync([outerPad, inner]);
  normalized.fill(0);
  block.fill(0);
  innerPad.fill(0);
  outerPad.fill(0);
  inner.fill(0);
  return result;
}

function tagsEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index++)
    difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

class Cursor {
  offset = 0;

  constructor(readonly bytes: Uint8Array) {}

  readByte(label: string): number {
    if (this.offset >= this.bytes.byteLength) throw invalid(`${label} is truncated`);
    return this.bytes[this.offset++]!;
  }

  readArgument(major: number, label: string): bigint {
    const initial = this.readByte(label);
    if (initial >>> 5 !== major) throw invalid(`${label} has the wrong CBOR type`);
    const additional = initial & 0x1f;
    if (additional < 24) return BigInt(additional);
    const width = additional === 24 ? 1 : additional === 25 ? 2
      : additional === 26 ? 4 : additional === 27 ? 8 : 0;
    if (width === 0) throw invalid(`${label} uses unsupported or indefinite framing`);
    if (this.offset + width > this.bytes.byteLength) throw invalid(`${label} is truncated`);
    let value = 0n;
    for (let index = 0; index < width; index++)
      value = (value << 8n) | BigInt(this.bytes[this.offset++]!);
    const minimum = width === 1 ? 24n : width === 2 ? 0x100n
      : width === 4 ? 0x1_0000n : 0x1_0000_0000n;
    if (value < minimum) throw invalid(`${label} is not deterministically encoded`);
    return value;
  }

  readInteger(label: string): bigint {
    if (this.offset >= this.bytes.byteLength) throw invalid(`${label} is truncated`);
    const major = this.bytes[this.offset]! >>> 5;
    if (major === 0) return this.readArgument(0, label);
    if (major === 1) return -1n - this.readArgument(1, label);
    throw invalid(`${label} must be an integer`);
  }

  readLength(major: number, label: string, maximum: number): number {
    const value = this.readArgument(major, label);
    if (value > BigInt(maximum)) throw invalid(`${label} exceeds its limit`);
    return Number(value);
  }

  readBytes(label: string, maximum: number): Uint8Array {
    const length = this.readLength(2, label, maximum);
    const end = this.offset + length;
    if (end > this.bytes.byteLength) throw invalid(`${label} is truncated`);
    const value = viewBytes(this.bytes, this.offset, end);
    this.offset = end;
    return value;
  }

  readText(label: string, maximum: number): string {
    const length = this.readLength(3, label, maximum);
    const end = this.offset + length;
    if (end > this.bytes.byteLength) throw invalid(`${label} is truncated`);
    try {
      const value = textDecoder.decode(viewBytes(this.bytes, this.offset, end));
      this.offset = end;
      return value;
    } catch {
      throw invalid(`${label} is not valid UTF-8`);
    }
  }

  expectInteger(expected: bigint, label: string): void {
    if (this.readInteger(label) !== expected) throw invalid(`${label} is unsupported`);
  }
}

function parseProtectedHeader(bytes: Uint8Array): AuthenticatedArchiveHeaderV1 {
  const cursor = new Cursor(bytes);
  if (cursor.readLength(5, "protected header map", 8) !== 8)
    throw invalid("protected header map is not closed");
  cursor.expectInteger(1n, "algorithm label");
  cursor.expectInteger(COSE_HMAC_256_256, "algorithm");
  cursor.expectInteger(2n, "critical-header label");
  if (cursor.readLength(4, "critical-header list", PRIVATE_LABELS.length) !== PRIVATE_LABELS.length)
    throw invalid("critical-header list is incomplete");
  for (const label of PRIVATE_LABELS) cursor.expectInteger(label, "critical-header label");
  cursor.expectInteger(3n, "content-type label");
  const contentType = cursor.readText("content type", 80);
  if (contentType !== CLAY_ARCHIVE_CONTENT_TYPE) throw invalid("archive content type is unsupported");
  cursor.expectInteger(4n, "key-id label");
  const keyId = copyBytes(cursor.readBytes("key id", 16));
  if (keyId.byteLength !== 16) throw invalid("key id must contain exactly 16 bytes");
  cursor.expectInteger(LABEL_AUTHENTICATION_VERSION, "authentication-version label");
  cursor.expectInteger(AUTHENTICATION_VERSION, "authentication version");
  cursor.expectInteger(LABEL_ARCHIVE_FORMAT, "archive-format label");
  cursor.expectInteger(ARCHIVE_FORMAT, "archive format");
  cursor.expectInteger(LABEL_BACKUP_SERIES_ID, "backup-series label");
  const seriesId = copyBytes(cursor.readBytes("backup series id", 16));
  if (seriesId.byteLength !== 16) throw invalid("backup series id must contain exactly 16 bytes");
  cursor.expectInteger(LABEL_BACKUP_GENERATION, "backup-generation label");
  const generation = cursor.readInteger("backup generation");
  if (generation < 1n || generation > MAX_UINT64)
    throw invalid("backup generation must be a positive uint64");
  if (cursor.offset !== bytes.byteLength) throw invalid("protected header has trailing fields");

  const header: AuthenticatedArchiveHeaderV1 = {
    authenticationVersion: 1,
    archiveFormat: 5,
    contentType: CLAY_ARCHIVE_CONTENT_TYPE,
    keyId,
    seriesId,
    generation,
  };
  if (!tagsEqual(bytes, encodeProtectedHeader(header)))
    throw invalid("protected header is not deterministically encoded");
  return header;
}

interface ParsedEnvelope {
  header: AuthenticatedArchiveHeaderV1;
  payload: Uint8Array;
  protectedHeader: Uint8Array;
  tag: Uint8Array;
}

function parseEnvelope(bytes: Uint8Array): ParsedEnvelope {
  if (!isPlainBytes(bytes)) throw invalid("envelope must be a plain byte array");
  if (bytes.byteLength > MAX_AUTHENTICATED_ARCHIVE_ENVELOPE_BYTES)
    throw new ClayError("E_LIMIT", "authenticated archive envelope exceeds the import limit");
  const cursor = new Cursor(bytes);
  if (cursor.readArgument(6, "COSE tag") !== COSE_MAC0_TAG)
    throw invalid("COSE tag must be 17");
  if (cursor.readLength(4, "COSE_Mac0 array", 4) !== 4)
    throw invalid("COSE_Mac0 array must contain four items");
  const protectedHeader = cursor.readBytes("protected header", 512);
  if (cursor.readLength(5, "unprotected map", 1) !== 0)
    throw invalid("unprotected map must be empty");
  const payload = cursor.readBytes(
    "archive payload", MAX_AUTHENTICATED_ARCHIVE_PAYLOAD_BYTES,
  );
  if (payload.byteLength === 0) throw invalid("archive payload must not be empty");
  const tag = cursor.readBytes("authentication tag", 32);
  if (tag.byteLength !== 32) throw invalid("authentication tag must contain exactly 32 bytes");
  if (cursor.offset !== bytes.byteLength) throw invalid("COSE_Mac0 framing has trailing bytes");
  return {
    header: parseProtectedHeader(protectedHeader),
    payload,
    protectedHeader,
    tag,
  };
}

export function sealAuthenticatedArchiveV5(
  payloadInput: Uint8Array,
  backupTrustKeyInput: Uint8Array,
  headerInput: AuthenticatedArchiveHeaderV1,
): Uint8Array {
  if (!isPlainBytes(payloadInput) || payloadInput.byteLength === 0)
    throw invalid("archive payload must be a nonempty plain byte array");
  if (payloadInput.byteLength > MAX_AUTHENTICATED_ARCHIVE_PAYLOAD_BYTES)
    throw new ClayError("E_LIMIT", "authenticated archive payload exceeds the export limit");
  const header = snapshotHeader(headerInput);
  const key = checkedBackupTrustKey(backupTrustKeyInput);
  const protectedHeader = encodeProtectedHeader(header);
  try {
    const tag = hmacSha256ChunksSync(key, macStructureChunks(protectedHeader, payloadInput));
    return concat([
      encodeHead(6, COSE_MAC0_TAG),
      encodeHead(4, 4n),
      encodeBytes(protectedHeader),
      encodeHead(5, 0n),
      encodeBytesHeader(payloadInput.byteLength),
      payloadInput,
      encodeBytes(tag),
    ]);
  } finally {
    key.fill(0);
  }
}

export function verifyAuthenticatedArchiveV5(
  envelope: Uint8Array,
  resolveKey: BackupTrustKeyResolver,
): VerifiedAuthenticatedArchiveV5 {
  if (typeof resolveKey !== "function") throw invalid("trusted key resolver is unavailable");
  const parsed = parseEnvelope(envelope);
  const hint: AuthenticatedArchiveKeyHintV1 = Object.freeze({
    authenticationVersion: 1,
    archiveFormat: 5,
    contentType: CLAY_ARCHIVE_CONTENT_TYPE,
    keyId: copyBytes(parsed.header.keyId),
    seriesId: copyBytes(parsed.header.seriesId),
    generation: parsed.header.generation,
  });
  let resolved: Uint8Array | null;
  try {
    resolved = resolveKey(hint);
  } catch {
    throw invalid("trusted Backup Trust Key resolution failed");
  }
  if (resolved === null) throw invalid("trusted Backup Trust Key was not found");
  const key = checkedBackupTrustKey(resolved);
  let expected: Uint8Array | undefined;
  try {
    expected = hmacSha256ChunksSync(
      key, macStructureChunks(parsed.protectedHeader, parsed.payload),
    );
    if (!tagsEqual(expected, parsed.tag))
      throw invalid("authentication tag does not match the trusted Backup Trust Key");
  } finally {
    key.fill(0);
    expected?.fill(0);
  }
  return {
    header: {
      ...parsed.header,
      keyId: copyBytes(parsed.header.keyId),
      seriesId: copyBytes(parsed.header.seriesId),
    },
    payload: copyBytes(parsed.payload),
  };
}
