import { BackupTrustCoordinator } from "@clay/kernel/backup-trust";
import { generateBackupTrustMaterialV1, encodeRecoveryKitV1 } from "@clay/kernel/recovery-kit";
import {
  type BackupFreshnessAssessment,
  type BackupTrustRecordStore,
  type BackupTrustReservationV1,
  type BackupTrustStatusV1,
  type BackupTrustMaterialV1,
  type SecureRandomFill,
} from "@clay/kernel/backup";
import { ClayError } from "@clay/kernel/errors";
import { withBackupTrustLock } from "./backup-operation-lock";

const ENROLLMENT_ID = /^enroll_[a-z2-7]{26}$/;
const MAX_ACTIVE_CAS_ATTEMPTS = 8;

export interface ActiveBackupTrustRecordStore extends BackupTrustRecordStore {
  loadActiveSeries(): Promise<{ revision: string; seriesId: string } | null>;
  compareAndSetActiveSeries(
    expectedRevision: string | null,
    seriesId: string,
  ): Promise<boolean>;
  loadAutomaticBackupCandidate?(seriesId: string): Promise<unknown | null>;
  compareAndSetAutomaticBackupCandidate?(
    seriesId: string,
    expectedRevision: string | null,
    next: unknown,
  ): Promise<boolean>;
  removeAutomaticBackupCandidate?(
    seriesId: string,
    expectedRevision: string,
  ): Promise<boolean>;
}

export type BackupTrustRuntimeStatus =
  | Readonly<{ status: "not_enrolled" }>
  | Readonly<{ status: "needs_test_import"; enrollmentId: string }>
  | Readonly<{
      status: "ready";
      freshness: "current" | "unknown";
      keyId: string;
      seriesId: string;
      nextGeneration: string;
      pending: BackupTrustStatusV1["pending"];
      committed: BackupTrustStatusV1["committed"];
    }>;

export type RecoveryKitEnrollment = Readonly<{
  enrollmentId: string;
  fileName: string;
  bytes: Uint8Array;
}>;

export type ImportedRecoveryKitStatus = Readonly<{
  status: "imported_verifier";
  freshness: "current" | "unknown";
  keyId: string;
  seriesId: string;
  activeForBackup: boolean;
}>;

export type ImportedSeriesActivation = Readonly<{
  seriesId: string;
  expectedActiveSeriesId: string | null;
  confirmation: "use_imported_recovery_kit_for_future_backups";
}>;

type PendingEnrollment = {
  material: BackupTrustMaterialV1;
  bytes: Uint8Array;
};

function invalid(message: string): ClayError {
  return new ClayError("E_VALIDATION", `Backup Trust enrollment is invalid: ${message}`);
}

function unavailable(message: string): ClayError {
  return new ClayError("E_CATALOG_UNAVAILABLE", message);
}

function copyMaterial(material: BackupTrustMaterialV1): BackupTrustMaterialV1 {
  return {
    backupTrustKey: material.backupTrustKey.slice(),
    keyId: material.keyId.slice(),
    seriesId: material.seriesId.slice(),
  };
}

function destroyMaterial(material: BackupTrustMaterialV1): void {
  material.backupTrustKey.fill(0);
  material.keyId.fill(0);
  material.seriesId.fill(0);
}

function bytesToHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

function defaultEnrollmentId(): string {
  if (!globalThis.crypto?.getRandomValues)
    throw unavailable("Secure enrollment identity generation is unavailable");
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(17));
  let bits = 0;
  let value = 0;
  let encoded = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && encoded.length < 26) {
      bits -= 5;
      encoded += alphabet[(value >>> bits) & 31];
      value &= (1 << bits) - 1;
    }
  }
  const id = `enroll_${encoded}`;
  if (!ENROLLMENT_ID.test(id)) throw unavailable("Secure enrollment identity generation failed");
  return id;
}

export class BackupTrustRuntime {
  readonly #coordinator: BackupTrustCoordinator;
  readonly #pending = new Map<string, PendingEnrollment>();
  readonly #randomFill?: SecureRandomFill;
  readonly #createEnrollmentId: () => string;

  constructor(
    private readonly store: ActiveBackupTrustRecordStore,
    options: {
      randomFill?: SecureRandomFill;
      createEnrollmentId?: () => string;
    } = {},
  ) {
    if (!store || typeof store.loadActiveSeries !== "function"
        || typeof store.compareAndSetActiveSeries !== "function")
      throw invalid("active-series storage is unavailable");
    this.#coordinator = new BackupTrustCoordinator(store);
    this.#randomFill = options.randomFill;
    this.#createEnrollmentId = options.createEnrollmentId ?? defaultEnrollmentId;
  }

  async status(): Promise<BackupTrustRuntimeStatus> {
    const pendingId = this.#pending.keys().next().value as string | undefined;
    if (pendingId !== undefined)
      return Object.freeze({ status: "needs_test_import", enrollmentId: pendingId });
    const active = await this.store.loadActiveSeries();
    if (active === null) return Object.freeze({ status: "not_enrolled" });
    const trust = await this.#coordinator.status(active.seriesId);
    if (trust === null)
      throw unavailable("The active Backup Trust series is unavailable");
    return this.#readyStatus(trust);
  }

  beginEnrollment(): RecoveryKitEnrollment {
    const material = generateBackupTrustMaterialV1(this.#randomFill);
    const bytes = encodeRecoveryKitV1(material);
    let enrollmentId: string;
    try {
      enrollmentId = this.#createEnrollmentId();
      if (!ENROLLMENT_ID.test(enrollmentId) || this.#pending.has(enrollmentId))
        throw invalid("enrollment identity is malformed or reused");
      for (const entry of this.#pending.values()) {
        destroyMaterial(entry.material);
        entry.bytes.fill(0);
      }
      this.#pending.clear();
      const storedMaterial = copyMaterial(material);
      const storedBytes = bytes.slice();
      this.#pending.set(enrollmentId, { material: storedMaterial, bytes: storedBytes });
      return Object.freeze({
        enrollmentId,
        fileName: `clay-recovery-kit-${bytesToHex(material.seriesId).slice(0, 12)}.txt`,
        bytes: bytes.slice(),
      });
    } finally {
      destroyMaterial(material);
      bytes.fill(0);
    }
  }

  async confirmEnrollment(
    enrollmentId: string,
    readBackBytes: Uint8Array,
  ): Promise<Extract<BackupTrustRuntimeStatus, { status: "ready" }>> {
    return withBackupTrustLock(() => this.#confirmEnrollment(enrollmentId, readBackBytes));
  }

  async #confirmEnrollment(enrollmentId: string, readBackBytes: Uint8Array): Promise<Extract<BackupTrustRuntimeStatus, { status: "ready" }>> {
    if (!ENROLLMENT_ID.test(enrollmentId) || !(readBackBytes instanceof Uint8Array))
      throw invalid("Recovery Kit read-back is malformed");
    const pending = this.#pending.get(enrollmentId);
    if (!pending) throw invalid("Recovery Kit enrollment is unavailable or expired");
    const lease = copyMaterial(pending.material);
    let result: Awaited<ReturnType<BackupTrustCoordinator["enrollNew"]>>;
    try {
      result = await this.#coordinator.enrollNew(
        lease, pending.bytes.slice(), readBackBytes.slice(),
      );
    } finally {
      destroyMaterial(lease);
    }
    await this.#activate(result.seriesId);
    this.#pending.delete(enrollmentId);
    destroyMaterial(pending.material);
    pending.bytes.fill(0);
    const status = await this.#coordinator.status(result.seriesId);
    if (!status) throw unavailable("Enrolled Backup Trust state failed read-back");
    return this.#readyStatus(status);
  }

  async importRecoveryKit(
    bytes: Uint8Array,
  ): Promise<ImportedRecoveryKitStatus> {
    if (!(bytes instanceof Uint8Array)) throw invalid("Recovery Kit bytes are malformed");
    const result = await this.#coordinator.importRecoveryKit(bytes.slice());
    const status = await this.#coordinator.status(result.seriesId);
    if (!status) throw unavailable("Imported Backup Trust state failed read-back");
    const active = await this.store.loadActiveSeries();
    return Object.freeze({
      status: "imported_verifier",
      freshness: status.committed === null ? "unknown" : "current",
      keyId: status.keyId,
      seriesId: status.seriesId,
      activeForBackup: active?.seriesId === status.seriesId,
    });
  }

  async activateImportedSeries(
    input: ImportedSeriesActivation,
  ): Promise<Extract<BackupTrustRuntimeStatus, { status: "ready" }>> {
    const captured = structuredClone(input);
    return withBackupTrustLock(() => this.#activateImportedSeries(captured));
  }

  async #activateImportedSeries(input: ImportedSeriesActivation): Promise<Extract<BackupTrustRuntimeStatus, { status: "ready" }>> {
    if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.getPrototypeOf(input) !== Object.prototype
        || Object.keys(input).sort().join("\u0000")
          !== "confirmation\u0000expectedActiveSeriesId\u0000seriesId"
        || !/^[0-9a-f]{32}$/.test(input.seriesId)
        || (input.expectedActiveSeriesId !== null
          && !/^[0-9a-f]{32}$/.test(input.expectedActiveSeriesId))
        || input.confirmation !== "use_imported_recovery_kit_for_future_backups")
      throw invalid("imported-series activation was not explicitly confirmed");
    const imported = await this.#coordinator.status(input.seriesId);
    if (!imported) throw invalid("imported Recovery Kit is unavailable");
    await this.#activate(input.seriesId, input.expectedActiveSeriesId);
    for (const pending of this.#pending.values()) {
      destroyMaterial(pending.material);
      pending.bytes.fill(0);
    }
    this.#pending.clear();
    const status = await this.#coordinator.status(input.seriesId);
    if (!status) throw unavailable("Activated Backup Trust state failed read-back");
    return this.#readyStatus(status);
  }

  async reserve(backupId: string): Promise<BackupTrustReservationV1> {
    const active = await this.#activeSeries();
    return this.#coordinator.reserve(active, backupId);
  }

  async keyForSeries(seriesId: string): Promise<Uint8Array | null> {
    return this.#coordinator.keyForSeries(seriesId);
  }

  async commit(
    seriesId: string,
    backupId: string,
    generation: bigint,
    envelope: Uint8Array,
  ): Promise<"committed" | "already_committed"> {
    return this.#coordinator.commit(seriesId, backupId, generation, envelope);
  }

  async abandon(seriesId: string, backupId: string, generation: bigint): Promise<void> {
    await this.#coordinator.abandon(seriesId, backupId, generation);
  }

  async loadAutomaticBackupCandidate(seriesId: string): Promise<unknown | null> {
    if (!/^[0-9a-f]{32}$/.test(seriesId)
        || typeof this.store.loadAutomaticBackupCandidate !== "function")
      throw unavailable("Durable automatic-backup candidate storage is unavailable");
    return this.store.loadAutomaticBackupCandidate(seriesId);
  }

  async compareAndSetAutomaticBackupCandidate(
    seriesId: string,
    expectedRevision: string | null,
    next: unknown,
  ): Promise<boolean> {
    if (!/^[0-9a-f]{32}$/.test(seriesId)
        || (expectedRevision !== null && !/^(0|[1-9][0-9]*)$/.test(expectedRevision))
        || typeof this.store.compareAndSetAutomaticBackupCandidate !== "function")
      throw unavailable("Durable automatic-backup candidate storage is unavailable");
    return this.store.compareAndSetAutomaticBackupCandidate(seriesId, expectedRevision, next);
  }

  async removeAutomaticBackupCandidate(
    seriesId: string,
    expectedRevision: string,
  ): Promise<boolean> {
    if (!/^[0-9a-f]{32}$/.test(seriesId)
        || !/^(0|[1-9][0-9]*)$/.test(expectedRevision)
        || typeof this.store.removeAutomaticBackupCandidate !== "function")
      throw unavailable("Durable automatic-backup candidate storage is unavailable");
    return this.store.removeAutomaticBackupCandidate(seriesId, expectedRevision);
  }

  async assess(
    hint: { keyId: Uint8Array; seriesId: Uint8Array; generation: bigint },
    envelope: Uint8Array,
  ): Promise<BackupFreshnessAssessment> {
    return this.#coordinator.assess(hint, envelope);
  }

  async #activeSeries(): Promise<string> {
    const active = await this.store.loadActiveSeries();
    if (!active) throw unavailable("Backup Trust is not enrolled");
    if (await this.#coordinator.status(active.seriesId) === null)
      throw unavailable("The active Backup Trust series is unavailable");
    return active.seriesId;
  }

  async #activate(seriesId: string, expectedSeriesId?: string | null): Promise<void> {
    for (let attempt = 0; attempt < MAX_ACTIVE_CAS_ATTEMPTS; attempt++) {
      const active = await this.store.loadActiveSeries();
      if (active?.seriesId === seriesId) return;
      if (active && ((await this.#coordinator.status(active.seriesId))?.pending
          || (this.store.loadAutomaticBackupCandidate && await this.store.loadAutomaticBackupCandidate(active.seriesId))))
        throw unavailable("Finish pending backup publication and retention before changing Recovery Kit series");
      if (expectedSeriesId !== undefined
          && (active?.seriesId ?? null) !== expectedSeriesId)
        throw unavailable("Active Backup Trust series changed before confirmed rotation");
      if (await this.store.compareAndSetActiveSeries(active?.revision ?? null, seriesId)) {
        const readBack = await this.store.loadActiveSeries();
        if (readBack?.seriesId !== seriesId)
          throw unavailable("Active Backup Trust series failed read-back");
        return;
      }
    }
    throw unavailable("Concurrent active Backup Trust updates exceeded the retry limit");
  }

  #readyStatus(
    status: BackupTrustStatusV1,
  ): Extract<BackupTrustRuntimeStatus, { status: "ready" }> {
    return Object.freeze({
      status: "ready",
      freshness: status.committed === null ? "unknown" : "current",
      keyId: status.keyId,
      seriesId: status.seriesId,
      nextGeneration: status.nextGeneration,
      pending: status.pending,
      committed: status.committed,
    });
  }
}
