import { BackupId } from "@clay/schema/standalone/backup";
import { ClayError } from "./errors";
import {
  decodeRecoveryKitV1,
  encodeRecoveryKitV1,
  type BackupTrustMaterialV1,
} from "./recovery-kit";
import { sha256HexSync } from "./state-digest";

const HEX_16 = /^[0-9a-f]{32}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const UINT64 = /^(?:0|[1-9][0-9]{0,19})$/;
const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_CAS_ATTEMPTS = 8;
const byteSlice = Uint8Array.prototype.slice;

export interface BackupTrustRecordStore {
  load(seriesId: string): Promise<unknown | null>;
  /** Implementations must atomically structured-clone `next` before resolving. */
  compareAndSet(
    seriesId: string,
    expectedRevision: string | null,
    next: unknown,
  ): Promise<boolean>;
}

export interface BackupTrustReservationV1 extends BackupTrustMaterialV1 {
  generation: bigint;
}

export type BackupFreshnessAssessment =
  | "current"
  | "unknown"
  | "future"
  | "replay"
  | "fork"
  | "wrong_key";

export type BackupTrustStatusV1 = Readonly<{
  keyId: string;
  seriesId: string;
  nextGeneration: string;
  pending: Readonly<PendingGeneration> | null;
  committed: Readonly<CommittedGeneration> | null;
}>;

interface PendingGeneration {
  backupId: string;
  generation: string;
}

interface CommittedGeneration extends PendingGeneration {
  envelopeSha256: string;
}

interface StoredBackupTrustV1 {
  schema: 1;
  revision: string;
  keyId: string;
  seriesId: string;
  backupTrustKey: Uint8Array;
  recoveryKitSha256: string;
  nextGeneration: string;
  pending: PendingGeneration | null;
  committed: CommittedGeneration | null;
}

function invalid(message: string): ClayError {
  return new ClayError("E_VALIDATION", `Backup trust state is invalid: ${message}`);
}

function unavailable(message: string): ClayError {
  return new ClayError("E_CATALOG_UNAVAILABLE", message);
}

function isPlainBytes(value: unknown, length?: number): value is Uint8Array {
  return value instanceof Uint8Array
    && Object.getPrototypeOf(value) === Uint8Array.prototype
    && value.buffer instanceof ArrayBuffer
    && (length === undefined || value.byteLength === length);
}

function copyBytes(value: Uint8Array): Uint8Array {
  return byteSlice.call(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index++)
    difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

function hexToBytes(hex: string): Uint8Array {
  const output = new Uint8Array(hex.length / 2);
  for (let index = 0; index < output.byteLength; index++)
    output[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return output;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${sha256HexSync(bytes)}`;
}

function exactRecord(input: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).length !== keys.length) return null;
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}

function uint64(value: unknown, positive = false): value is string {
  if (typeof value !== "string" || !UINT64.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed <= MAX_UINT64 && (!positive || parsed > 0n);
  } catch {
    return false;
  }
}

function parsePending(input: unknown): PendingGeneration | null | undefined {
  if (input === null) return null;
  const record = exactRecord(input, ["backupId", "generation"]);
  if (!record || !BackupId.safeParse(record.backupId).success || !uint64(record.generation, true))
    return undefined;
  return { backupId: record.backupId as string, generation: record.generation };
}

function parseCommitted(input: unknown): CommittedGeneration | null | undefined {
  if (input === null) return null;
  const record = exactRecord(input, ["backupId", "generation", "envelopeSha256"]);
  if (!record || !BackupId.safeParse(record.backupId).success
      || !uint64(record.generation, true)
      || typeof record.envelopeSha256 !== "string" || !SHA256.test(record.envelopeSha256))
    return undefined;
  return {
    backupId: record.backupId as string,
    generation: record.generation,
    envelopeSha256: record.envelopeSha256,
  };
}

function parseStored(input: unknown, expectedSeries?: string): StoredBackupTrustV1 {
  const record = exactRecord(input, [
    "schema", "revision", "keyId", "seriesId", "backupTrustKey", "recoveryKitSha256",
    "nextGeneration", "pending", "committed",
  ]);
  const pending = record ? parsePending(record.pending) : undefined;
  const committed = record ? parseCommitted(record.committed) : undefined;
  if (!record || record.schema !== 1 || !uint64(record.revision)
      || typeof record.keyId !== "string" || !HEX_16.test(record.keyId)
      || typeof record.seriesId !== "string" || !HEX_16.test(record.seriesId)
      || record.keyId === record.seriesId
      || (expectedSeries !== undefined && record.seriesId !== expectedSeries)
      || !isPlainBytes(record.backupTrustKey, 32)
      || typeof record.recoveryKitSha256 !== "string" || !SHA256.test(record.recoveryKitSha256)
      || !uint64(record.nextGeneration, true)
      || pending === undefined || committed === undefined)
    throw invalid("persisted record is malformed");
  const key = copyBytes(record.backupTrustKey);
  let nonzero = 0;
  for (const byte of key) nonzero |= byte;
  if (nonzero === 0) {
    key.fill(0);
    throw invalid("persisted Backup Trust Key lacks entropy");
  }
  if (committed && BigInt(committed.generation) >= BigInt(record.nextGeneration)
      && BigInt(committed.generation) !== MAX_UINT64) {
    key.fill(0);
    throw invalid("committed generation is not below the next generation");
  }
  if (pending) {
    const generation = BigInt(pending.generation);
    const next = BigInt(record.nextGeneration);
    if (generation > next || (generation !== MAX_UINT64 && generation + 1n !== next)) {
      key.fill(0);
      throw invalid("pending generation does not match the next generation");
    }
  }
  return {
    schema: 1,
    revision: record.revision,
    keyId: record.keyId,
    seriesId: record.seriesId,
    backupTrustKey: key,
    recoveryKitSha256: record.recoveryKitSha256,
    nextGeneration: record.nextGeneration,
    pending,
    committed,
  };
}

function cloneStored(record: StoredBackupTrustV1): StoredBackupTrustV1 {
  return {
    ...record,
    backupTrustKey: copyBytes(record.backupTrustKey),
    pending: record.pending ? { ...record.pending } : null,
    committed: record.committed ? { ...record.committed } : null,
  };
}

function destroyStored(record: StoredBackupTrustV1): void {
  record.backupTrustKey.fill(0);
}

function nextRevision(revision: string): string {
  const value = BigInt(revision);
  if (value >= MAX_UINT64) throw unavailable("Backup trust state revision is exhausted");
  return (value + 1n).toString();
}

function materialEquals(left: BackupTrustMaterialV1, right: BackupTrustMaterialV1): boolean {
  return bytesEqual(left.keyId, right.keyId)
    && bytesEqual(left.seriesId, right.seriesId)
    && bytesEqual(left.backupTrustKey, right.backupTrustKey);
}

function destroyMaterial(material: BackupTrustMaterialV1): void {
  material.keyId.fill(0);
  material.seriesId.fill(0);
  material.backupTrustKey.fill(0);
}

function enrollmentResult(record: StoredBackupTrustV1): {
  keyId: string;
  seriesId: string;
  freshness: "unknown";
} {
  return { keyId: record.keyId, seriesId: record.seriesId, freshness: "unknown" };
}

function storedFromKit(
  material: BackupTrustMaterialV1,
  recoveryKitBytes: Uint8Array,
): StoredBackupTrustV1 {
  return {
    schema: 1,
    revision: "0",
    keyId: bytesToHex(material.keyId),
    seriesId: bytesToHex(material.seriesId),
    backupTrustKey: copyBytes(material.backupTrustKey),
    recoveryKitSha256: sha256(recoveryKitBytes),
    nextGeneration: "1",
    pending: null,
    committed: null,
  };
}

export class BackupTrustCoordinator {
  constructor(private readonly store: BackupTrustRecordStore) {
    if (!store || typeof store.load !== "function" || typeof store.compareAndSet !== "function")
      throw invalid("record store is unavailable");
  }

  async enrollNew(
    input: BackupTrustMaterialV1,
    exportedKit: Uint8Array,
    readBackKit: Uint8Array,
  ): Promise<{ keyId: string; seriesId: string; freshness: "unknown" }> {
    const canonicalKit = encodeRecoveryKitV1(input);
    if (!isPlainBytes(exportedKit) || !isPlainBytes(readBackKit)
        || !bytesEqual(exportedKit, canonicalKit) || !bytesEqual(readBackKit, canonicalKit))
      throw invalid("exact Recovery Kit export and read-back are required");
    const material = decodeRecoveryKitV1(canonicalKit);
    const record = storedFromKit(material, canonicalKit);
    try {
      if (await this.store.compareAndSet(record.seriesId, null, cloneStored(record)))
        return enrollmentResult(record);
      const existing = parseStored(await this.store.load(record.seriesId), record.seriesId);
      try {
        if (existing.keyId !== record.keyId
            || existing.recoveryKitSha256 !== record.recoveryKitSha256
            || !bytesEqual(existing.backupTrustKey, record.backupTrustKey))
          throw unavailable("A different Backup Trust Key already owns this series");
        return enrollmentResult(existing);
      } finally {
        destroyStored(existing);
      }
    } finally {
      destroyMaterial(material);
      destroyStored(record);
      canonicalKit.fill(0);
    }
  }

  async importRecoveryKit(
    bytes: Uint8Array,
  ): Promise<{ keyId: string; seriesId: string; freshness: "unknown" }> {
    const material = decodeRecoveryKitV1(bytes);
    const canonical = encodeRecoveryKitV1(material);
    const record = storedFromKit(material, canonical);
    try {
      if (await this.store.compareAndSet(record.seriesId, null, cloneStored(record)))
        return enrollmentResult(record);
      const existing = parseStored(await this.store.load(record.seriesId), record.seriesId);
      try {
        if (existing.keyId !== record.keyId
            || existing.recoveryKitSha256 !== record.recoveryKitSha256
            || !bytesEqual(existing.backupTrustKey, record.backupTrustKey))
          throw unavailable("A different Backup Trust Key already owns this series");
        return enrollmentResult(existing);
      } finally {
        destroyStored(existing);
      }
    } finally {
      destroyMaterial(material);
      destroyStored(record);
      canonical.fill(0);
    }
  }

  async keyForSeries(seriesId: string): Promise<Uint8Array | null> {
    if (!HEX_16.test(seriesId)) throw invalid("series id is malformed");
    const raw = await this.store.load(seriesId);
    if (raw === null) return null;
    const record = parseStored(raw, seriesId);
    try {
      return copyBytes(record.backupTrustKey);
    } finally {
      destroyStored(record);
    }
  }

  async status(seriesId: string): Promise<BackupTrustStatusV1 | null> {
    if (!HEX_16.test(seriesId)) throw invalid("series id is malformed");
    const raw = await this.store.load(seriesId);
    if (raw === null) return null;
    const record = parseStored(raw, seriesId);
    try {
      return Object.freeze({
        keyId: record.keyId,
        seriesId: record.seriesId,
        nextGeneration: record.nextGeneration,
        pending: record.pending ? Object.freeze({ ...record.pending }) : null,
        committed: record.committed ? Object.freeze({ ...record.committed }) : null,
      });
    } finally {
      destroyStored(record);
    }
  }

  async reserve(seriesId: string, backupIdInput: string): Promise<BackupTrustReservationV1> {
    if (!HEX_16.test(seriesId)) throw invalid("series id is malformed");
    const backupId = BackupId.parse(backupIdInput);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const raw = await this.store.load(seriesId);
      if (raw === null) throw unavailable("Backup Trust series is not enrolled");
      const current = parseStored(raw, seriesId);
      let next: StoredBackupTrustV1 | undefined;
      try {
        if (current.pending) {
          if (current.pending.backupId !== backupId)
            throw unavailable("A backup generation is already reserved");
          return {
            backupTrustKey: copyBytes(current.backupTrustKey),
            keyId: hexToBytes(current.keyId),
            seriesId: hexToBytes(current.seriesId),
            generation: BigInt(current.pending.generation),
          };
        }
        if (current.committed?.generation === MAX_UINT64.toString())
          throw unavailable("Backup generation is exhausted");
        const generation = BigInt(current.nextGeneration);
        next = cloneStored(current);
        next.revision = nextRevision(current.revision);
        next.pending = { backupId, generation: generation.toString() };
        next.nextGeneration = generation === MAX_UINT64
          ? MAX_UINT64.toString()
          : (generation + 1n).toString();
        if (await this.store.compareAndSet(seriesId, current.revision, cloneStored(next)))
          return {
            backupTrustKey: copyBytes(current.backupTrustKey),
            keyId: hexToBytes(current.keyId),
            seriesId: hexToBytes(current.seriesId),
            generation,
          };
      } finally {
        destroyStored(current);
        if (next) destroyStored(next);
      }
    }
    throw unavailable("Concurrent Backup Trust updates exceeded the retry limit");
  }

  async abandon(seriesId: string, backupIdInput: string, generation: bigint): Promise<void> {
    if (!HEX_16.test(seriesId) || generation < 1n || generation > MAX_UINT64)
      throw invalid("abandonment identity is malformed");
    const backupId = BackupId.parse(backupIdInput);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const raw = await this.store.load(seriesId);
      if (raw === null) throw unavailable("Backup Trust series is not enrolled");
      const current = parseStored(raw, seriesId);
      let next: StoredBackupTrustV1 | undefined;
      try {
        if (!current.pending) return;
        if (current.pending.backupId !== backupId
            || current.pending.generation !== generation.toString())
          throw unavailable("Backup generation reservation does not match abandonment");
        // There is no successor after uint64 max. Keep the terminal reservation
        // bound to this backup ID so it can be retried but can never be reused.
        if (generation === MAX_UINT64) return;
        next = cloneStored(current);
        next.revision = nextRevision(current.revision);
        next.pending = null;
        if (await this.store.compareAndSet(seriesId, current.revision, cloneStored(next))) return;
      } finally {
        destroyStored(current);
        if (next) destroyStored(next);
      }
    }
    throw unavailable("Concurrent Backup Trust updates exceeded the retry limit");
  }

  async commit(
    seriesId: string,
    backupIdInput: string,
    generation: bigint,
    envelope: Uint8Array,
  ): Promise<"committed" | "already_committed"> {
    if (!HEX_16.test(seriesId) || generation < 1n || generation > MAX_UINT64
        || !isPlainBytes(envelope) || envelope.byteLength === 0)
      throw invalid("commit evidence is malformed");
    const backupId = BackupId.parse(backupIdInput);
    const envelopeSha256 = sha256(envelope);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const raw = await this.store.load(seriesId);
      if (raw === null) throw unavailable("Backup Trust series is not enrolled");
      const current = parseStored(raw, seriesId);
      let next: StoredBackupTrustV1 | undefined;
      try {
        if (current.committed?.generation === generation.toString()) {
          if (current.committed.backupId === backupId
              && current.committed.envelopeSha256 === envelopeSha256)
            return "already_committed";
          throw unavailable("Backup generation fork detected");
        }
        if (!current.pending || current.pending.backupId !== backupId
            || current.pending.generation !== generation.toString())
          throw unavailable("Backup generation reservation does not match commit");
        if (current.committed && BigInt(current.committed.generation) >= generation)
          throw unavailable("Backup generation replay detected");
        next = cloneStored(current);
        next.revision = nextRevision(current.revision);
        next.pending = null;
        next.committed = { backupId, generation: generation.toString(), envelopeSha256 };
        if (await this.store.compareAndSet(seriesId, current.revision, cloneStored(next)))
          return "committed";
      } finally {
        destroyStored(current);
        if (next) destroyStored(next);
      }
    }
    throw unavailable("Concurrent Backup Trust updates exceeded the retry limit");
  }

  async assess(
    hint: { keyId: Uint8Array; seriesId: Uint8Array; generation: bigint },
    envelope: Uint8Array,
  ): Promise<BackupFreshnessAssessment> {
    if (!isPlainBytes(hint.keyId, 16) || !isPlainBytes(hint.seriesId, 16)
        || typeof hint.generation !== "bigint" || hint.generation < 0n
        || hint.generation > MAX_UINT64 || !isPlainBytes(envelope) || envelope.byteLength === 0)
      throw invalid("freshness evidence is malformed");
    const seriesId = bytesToHex(hint.seriesId);
    const raw = await this.store.load(seriesId);
    if (raw === null) return "unknown";
    const current = parseStored(raw, seriesId);
    try {
      if (current.keyId !== bytesToHex(hint.keyId)) return "wrong_key";
      if (!current.committed) return "unknown";
      const committed = BigInt(current.committed.generation);
      if (hint.generation < committed) return "replay";
      if (hint.generation > committed) return "future";
      return sha256(envelope) === current.committed.envelopeSha256 ? "current" : "fork";
    } finally {
      destroyStored(current);
    }
  }
}
