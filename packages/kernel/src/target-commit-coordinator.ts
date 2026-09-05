import { OperationId, UInt64Decimal } from "@clay/schema";
import { TargetEvidenceV1, WriteFenceV1 } from "@clay/schema/catalog";
import type {
  CatalogReservationRecoveryV1 as CatalogReservationRecovery,
  TargetEvidenceV1 as TargetEvidence,
  WriteFenceV1 as WriteFence,
} from "@clay/schema/catalog";
import { DeviceCatalog } from "./device-catalog";
import { ClayError } from "./errors";
import type { LiveWriteGuard } from "./live-write-guard";
import type { Registry } from "./registry";
import { sha256HexSync } from "./state-digest";
import { stateLeafHashV1 } from "./state-merkle";
import { StateMerkleIndex, type StateMerkleChange } from "./state-merkle-index";
import { TargetAuthorityStore } from "./target-authority";

export type TargetCommitInput = {
  expectedTarget: TargetEvidence;
  expectedCatalogGeneration?: string;
  fence?: WriteFence;
  operationId: string;
  changes: StateMerkleChange[];
  mutate: () => unknown;
};

export type TargetCommitResult = {
  changed: boolean;
  evidence: TargetEvidence;
};

export type RecoverExpiredReservationInput = {
  expectedAuthorityIncarnationId: string;
  expectedCatalogGeneration: string;
  expectedWriteEpoch: string;
  operationId: string;
  releaseId: string;
  ttlMs: number;
};

function sameTarget(left: TargetEvidence, right: TargetEvidence): boolean {
  return left.appInstanceId === right.appInstanceId
    && left.activeGenerationId === right.activeGenerationId
    && left.lineageEpoch === right.lineageEpoch
    && left.protectionRevision === right.protectionRevision
    && left.digestSchema === right.digestSchema
    && left.stateSha256 === right.stateSha256;
}

function trustedInstant(clock: () => number): { milliseconds: number; instant: string } {
  const milliseconds = clock();
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
    throw new ClayError("E_TARGET_AUTHORITY_INVALID", "trusted worker clock is invalid");
  try {
    return { milliseconds, instant: new Date(milliseconds).toISOString() };
  } catch {
    throw new ClayError("E_TARGET_AUTHORITY_INVALID", "trusted worker clock is invalid");
  }
}

const requestEncoder = new TextEncoder();

function requestFingerprint(expected: TargetEvidence, changes: StateMerkleChange[]): string {
  const seen = new Set<string>();
  const canonicalChanges = changes.map(change => {
    if (seen.has(change.key))
      throw new ClayError("E_TARGET_AUTHORITY_INVALID", "duplicate target change key");
    seen.add(change.key);
    return {
      key: change.key,
      stateSha256: change.fields === null ? null : stateLeafHashV1(change.key, change.fields),
    };
  }).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  const payload = JSON.stringify({
    schema: 1,
    expectedTarget: {
      appInstanceId: expected.appInstanceId,
      activeGenerationId: expected.activeGenerationId,
      lineageEpoch: expected.lineageEpoch,
      protectionRevision: expected.protectionRevision,
      digestSchema: expected.digestSchema,
      stateSha256: expected.stateSha256,
    },
    changes: canonicalChanges,
  });
  return `sha256:${sha256HexSync(requestEncoder.encode(payload))}`;
}

type CapturedField = NonNullable<StateMerkleChange["fields"]>[number];

function captureField(input: unknown): CapturedField {
  if (typeof input !== "object" || input === null) throw new Error("invalid state field");
  const record = input as Record<string, unknown>;
  const name = record.name;
  const kind = record.kind;
  if (typeof name !== "string") throw new Error("invalid state field name");
  if (kind === "null") return { name, kind };
  if (kind === "integer" || kind === "text") {
    const value = record.value;
    if (typeof value !== "string") throw new Error("invalid state field value");
    return { name, kind, value };
  }
  if (kind === "real") {
    const value = record.value;
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error("invalid real state field");
    return { name, kind, value };
  }
  if (kind === "content") {
    const sha256 = record.sha256;
    const bytes = record.bytes;
    if (typeof sha256 !== "string" || typeof bytes !== "string")
      throw new Error("invalid content state field");
    return { name, kind, sha256, bytes };
  }
  throw new Error("invalid state field kind");
}

function captureChanges(input: unknown[]): StateMerkleChange[] {
  const changeCount = input.length;
  const output = new Array<StateMerkleChange>(changeCount);
  for (let index = 0; index < changeCount; index++) {
    const candidate = input[index];
    if (typeof candidate !== "object" || candidate === null)
      throw new Error("invalid state change");
    const record = candidate as Record<string, unknown>;
    const key = record.key;
    const candidateFields = record.fields;
    if (typeof key !== "string") throw new Error("invalid state change key");
    if (candidateFields === null) {
      output[index] = { key, fields: null };
      continue;
    }
    if (!Array.isArray(candidateFields)) throw new Error("invalid state change fields");
    const fieldCount = candidateFields.length;
    const fields = new Array<CapturedField>(fieldCount);
    for (let fieldIndex = 0; fieldIndex < fieldCount; fieldIndex++)
      fields[fieldIndex] = captureField(candidateFields[fieldIndex]);
    output[index] = { key, fields };
  }
  return output;
}

export class TargetCommitCoordinator {
  constructor(
    private readonly driver: LiveWriteGuard,
    private readonly registry?: Registry,
    private readonly clock: () => number = Date.now,
  ) {}

  recoverExpiredReservation(input: RecoverExpiredReservationInput): CatalogReservationRecovery {
    const operation = OperationId.safeParse(input.operationId);
    if (!operation.success)
      throw new ClayError("E_TARGET_AUTHORITY_INVALID", "reservation recovery operation is invalid");
    const recoveryTime = trustedInstant(this.clock);
    const catalog = DeviceCatalog.openExisting(this.driver);
    const target = TargetAuthorityStore.open(this.driver);
    const targetReservation = target.reservations()
      .find(candidate => candidate.operationId === operation.data);
    const catalogReservation = catalog.revisionReservations()
      .find(candidate => candidate.operationId === operation.data);
    const current = target.evidence();
    const catalogSnapshot = catalog.snapshot();
    const entry = catalogSnapshot.entries.find(candidate =>
      candidate.appInstanceId === catalogSnapshot.selectedAppInstanceId);
    if (!targetReservation || targetReservation.state !== "reserved"
        || !catalogReservation || catalogReservation.state !== "reserved"
        || !entry
        || targetReservation.revision !== catalogReservation.revision
        || targetReservation.expectedProtectionRevision
          !== catalogReservation.expectedProtectionRevision
        || targetReservation.expectedStateSha256 !== catalogReservation.expectedStateSha256
        || targetReservation.requestSha256 !== catalogReservation.requestSha256
        || targetReservation.reservedAt !== catalogReservation.reservedAt
        || current.appInstanceId !== catalogReservation.appInstanceId
        || current.activeGenerationId !== catalogReservation.activeGenerationId
        || current.lineageEpoch !== catalogReservation.lineageEpoch
        || current.protectionRevision !== catalogReservation.expectedProtectionRevision
        || current.stateSha256 !== catalogReservation.expectedStateSha256
        || entry.appInstanceId !== current.appInstanceId
        || entry.activeGenerationId !== current.activeGenerationId
        || entry.currentLineageEpoch !== current.lineageEpoch
        || entry.currentProtectionRevision !== current.protectionRevision
        || entry.stateSha256 !== current.stateSha256)
      throw new ClayError("E_TARGET_AUTHORITY_INVALID", "mirrored reservation recovery is inconsistent");
    return this.driver.runAuthorized(() => {
      const recovery = catalog.recoverExpiredSelectedReservation({
        expectedAuthorityIncarnationId: input.expectedAuthorityIncarnationId,
        expectedCatalogGeneration: input.expectedCatalogGeneration,
        expectedWriteEpoch: input.expectedWriteEpoch,
        operationId: operation.data,
        releaseId: input.releaseId,
        nowMs: recoveryTime.milliseconds,
        ttlMs: input.ttlMs,
      });
      const abandoned = target.abandonProtectionRevision(operation.data, recoveryTime.instant);
      const after = target.reservations()
        .find(candidate => candidate.operationId === operation.data);
      if (abandoned.state !== "abandoned" || abandoned.revision !== catalogReservation.revision
          || !after || after.state !== "abandoned"
          || after.revision !== recovery.abandonedReservation.revision
          || after.finalizedAt !== recovery.abandonedReservation.finalizedAt)
        throw new ClayError("E_TARGET_AUTHORITY_INVALID", "mirrored reservation recovery failed read-back");
      return recovery;
    });
  }

  commit(input: TargetCommitInput): TargetCommitResult {
    let captured: TargetCommitInput;
    try {
      captured = {
        expectedTarget: input.expectedTarget,
        expectedCatalogGeneration: input.expectedCatalogGeneration,
        fence: input.fence,
        operationId: input.operationId,
        changes: input.changes,
        mutate: input.mutate,
      };
    } catch {
      throw new ClayError("E_TARGET_AUTHORITY_INVALID", "target commit input is invalid");
    }
    const expected = TargetEvidenceV1.safeParse(captured.expectedTarget);
    const operation = OperationId.safeParse(captured.operationId);
    if (!expected.success || !operation.success
        || !Array.isArray(captured.changes) || typeof captured.mutate !== "function")
      throw new ClayError("E_TARGET_AUTHORITY_INVALID", "target commit input is invalid");
    let fingerprint: string;
    let preparedChanges: StateMerkleChange[];
    try {
      preparedChanges = captureChanges(captured.changes);
      fingerprint = requestFingerprint(expected.data, preparedChanges);
    } catch {
      throw new ClayError("E_TARGET_AUTHORITY_INVALID", "target commit fingerprint is invalid");
    }
    let catalogAuthority: { generation: string; fence: WriteFence } | null = null;
    let catalog: DeviceCatalog | null = null;
    if (captured.expectedCatalogGeneration !== undefined && captured.fence !== undefined) {
      const catalogGeneration = UInt64Decimal.safeParse(captured.expectedCatalogGeneration);
      const fence = WriteFenceV1.safeParse(captured.fence);
      if (!catalogGeneration.success || !fence.success)
        throw new ClayError("E_TARGET_AUTHORITY_INVALID", "target commit catalog authority is invalid");
      catalogAuthority = { generation: catalogGeneration.data, fence: fence.data };
      catalog = DeviceCatalog.openExisting(this.driver);
    } else if (captured.expectedCatalogGeneration !== undefined || captured.fence !== undefined) {
      throw new ClayError("E_TARGET_AUTHORITY_INVALID", "target commit catalog authority is invalid");
    }
    const target = TargetAuthorityStore.open(this.driver);
    const committed = target.committedEvidence(operation.data, expected.data, fingerprint);
    if (committed) {
      if (!catalog || catalogAuthority === null)
        throw new ClayError("E_TARGET_AUTHORITY_INVALID", "committed replay requires catalog authority");
      const replayTime = trustedInstant(this.clock);
      const catalogReservation = catalog.reserveSelectedProtectionRevision({
        expectedCatalogGeneration: catalogAuthority.generation,
        expectedTarget: expected.data,
        operationId: operation.data,
        requestSha256: fingerprint,
        fence: catalogAuthority.fence,
        nowMs: replayTime.milliseconds,
      });
      if (catalogReservation.state !== "committed"
          || catalogReservation.revision !== committed.protectionRevision
          || catalogReservation.operationId !== operation.data)
        throw new ClayError("E_TARGET_AUTHORITY_INVALID", "target and catalog commit diverged");
      catalog.publishSelectedTarget({
        expectedCatalogGeneration: catalogReservation.reservedCatalogGeneration,
        expectedTarget: expected.data,
        publishedTarget: committed,
        operationId: operation.data,
        requestSha256: fingerprint,
        fence: catalogAuthority.fence,
        nowMs: replayTime.milliseconds,
      });
      return { changed: true, evidence: committed };
    }
    const current = target.evidence();
    if (!sameTarget(current, expected.data))
      throw new ClayError("E_GENERATION_NOT_SELECTED", "expected target is not current");
    const index = StateMerkleIndex.open(this.driver);
    if (!index.wouldChange(preparedChanges)) return { changed: false, evidence: current };
    if (!catalog || catalogAuthority === null)
      throw new ClayError("E_TARGET_AUTHORITY_INVALID", "meaningful target commit requires catalog authority");
    if (!this.registry)
      throw new ClayError("E_TARGET_AUTHORITY_INVALID", "trusted canonical registry is unavailable");
    const reservedTime = trustedInstant(this.clock);
    let reservedCatalogGeneration: string | null = null;
    this.driver.runAuthorized(() => {
      const targetReservation = target.reserveProtectionRevision(
        operation.data, reservedTime.instant, expected.data, fingerprint);
      if (!catalog) return;
      const catalogReservation = catalog.reserveSelectedProtectionRevision({
        expectedCatalogGeneration: catalogAuthority!.generation,
        expectedTarget: expected.data,
        operationId: operation.data,
        requestSha256: fingerprint,
        fence: catalogAuthority!.fence,
        nowMs: reservedTime.milliseconds,
      });
      const targetJournal = target.reservations()
        .find(candidate => candidate.operationId === operation.data);
      if (catalogReservation.state !== "reserved"
          || catalogReservation.revision !== targetReservation.revision
          || !targetJournal || targetJournal.state !== "reserved"
          || targetJournal.revision !== targetReservation.revision
          || targetJournal.operationId !== operation.data
          || catalogReservation.operationId !== operation.data)
        throw new ClayError("E_TARGET_AUTHORITY_INVALID", "target and catalog reservation diverged");
      reservedCatalogGeneration = catalogReservation.reservedCatalogGeneration;
    });
    try {
      const finalizedTime = trustedInstant(this.clock);
      if (finalizedTime.milliseconds < reservedTime.milliseconds)
        throw new ClayError("E_TARGET_AUTHORITY_INVALID", "trusted worker clock moved backward");
      const evidence = this.driver.runAuthorized(() => {
        catalog.assertWriteFence(catalogAuthority.fence, finalizedTime.milliseconds);
        const committedTarget = target.commitReservedProtectionRevision({
          operationId: operation.data,
          expectedTarget: expected.data,
          finalizedAt: finalizedTime.instant,
          changes: preparedChanges,
          requestSha256: fingerprint,
          mutate: captured.mutate,
          registry: this.registry!,
        });
        if (catalog) {
          if (reservedCatalogGeneration === null)
            throw new ClayError("E_TARGET_AUTHORITY_INVALID", "catalog reservation is unavailable");
          catalog.publishSelectedTarget({
            expectedCatalogGeneration: reservedCatalogGeneration,
            expectedTarget: expected.data,
            publishedTarget: committedTarget,
            operationId: operation.data,
            requestSha256: fingerprint,
            fence: catalogAuthority!.fence,
            nowMs: finalizedTime.milliseconds,
          });
          const targetJournal = target.reservations()
            .find(candidate => candidate.operationId === operation.data);
          const catalogJournal = catalog.revisionReservations()
            .find(candidate => candidate.operationId === operation.data);
          if (!targetJournal || !catalogJournal
              || targetJournal.operationId !== operation.data
              || catalogJournal.operationId !== operation.data
              || targetJournal.state !== "committed" || catalogJournal.state !== "committed"
              || targetJournal.revision !== catalogJournal.revision
              || targetJournal.revision !== committedTarget.protectionRevision)
            throw new ClayError("E_TARGET_AUTHORITY_INVALID", "mirrored commit failed read-back");
        }
        return committedTarget;
      });
      return { changed: true, evidence };
    } catch (error) {
      try {
        const abandonedTime = trustedInstant(this.clock);
        if (abandonedTime.milliseconds < reservedTime.milliseconds)
          throw new ClayError("E_TARGET_AUTHORITY_INVALID", "trusted worker clock moved backwards");
        this.driver.runAuthorized(() => {
          target.abandonProtectionRevision(operation.data, abandonedTime.instant);
          if (catalog) {
            if (reservedCatalogGeneration === null)
              throw new ClayError("E_TARGET_AUTHORITY_INVALID", "catalog reservation is unavailable");
            catalog.abandonSelectedProtectionRevision({
              expectedCatalogGeneration: reservedCatalogGeneration,
              expectedTarget: expected.data,
              operationId: operation.data,
              requestSha256: fingerprint,
              fence: catalogAuthority!.fence,
              nowMs: abandonedTime.milliseconds,
            });
          }
        });
      } catch {
        throw new ClayError(
          "E_TARGET_AUTHORITY_INVALID",
          "target commit failed and reservation recovery is required",
        );
      }
      throw error;
    }
  }
}
