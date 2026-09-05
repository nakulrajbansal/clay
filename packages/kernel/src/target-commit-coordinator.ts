import { OperationId, TargetEvidenceV1 } from "@clay/schema";
import type { TargetEvidenceV1 as TargetEvidence } from "@clay/schema";
import { ClayError } from "./errors";
import type { LiveWriteGuard } from "./live-write-guard";
import type { Registry } from "./registry";
import { sha256HexSync } from "./state-digest";
import { stateLeafHashV1 } from "./state-merkle";
import { StateMerkleIndex, type StateMerkleChange } from "./state-merkle-index";
import { TargetAuthorityStore } from "./target-authority";

export type TargetCommitInput = {
  expectedTarget: TargetEvidence;
  operationId: string;
  reservedAt: string;
  finalizedAt: string;
  changes: StateMerkleChange[];
  mutate: () => unknown;
};

export type TargetCommitResult = {
  changed: boolean;
  evidence: TargetEvidence;
};

function sameTarget(left: TargetEvidence, right: TargetEvidence): boolean {
  return left.appInstanceId === right.appInstanceId
    && left.activeGenerationId === right.activeGenerationId
    && left.lineageEpoch === right.lineageEpoch
    && left.protectionRevision === right.protectionRevision
    && left.digestSchema === right.digestSchema
    && left.stateSha256 === right.stateSha256;
}

function canonicalInstant(value: string): boolean {
  return !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
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

export class TargetCommitCoordinator {
  constructor(
    private readonly driver: LiveWriteGuard,
    private readonly registry?: Registry,
  ) {}

  commit(input: TargetCommitInput): TargetCommitResult {
    const expected = TargetEvidenceV1.safeParse(input.expectedTarget);
    if (!expected.success || !OperationId.safeParse(input.operationId).success
        || !Array.isArray(input.changes) || typeof input.mutate !== "function")
      throw new ClayError("E_TARGET_AUTHORITY_INVALID", "target commit input is invalid");
    let fingerprint: string;
    let preparedChanges: StateMerkleChange[];
    try {
      preparedChanges = input.changes.map(change => ({
        key: change.key,
        fields: change.fields === null ? null : change.fields.map(field => ({ ...field })),
      }));
      fingerprint = requestFingerprint(expected.data, preparedChanges);
    } catch {
      throw new ClayError("E_TARGET_AUTHORITY_INVALID", "target commit fingerprint is invalid");
    }
    const target = TargetAuthorityStore.open(this.driver);
    const committed = target.committedEvidence(input.operationId, expected.data, fingerprint);
    if (committed) return { changed: true, evidence: committed };
    const current = target.evidence();
    if (!sameTarget(current, expected.data))
      throw new ClayError("E_GENERATION_NOT_SELECTED", "expected target is not current");
    const index = StateMerkleIndex.open(this.driver);
    if (!index.wouldChange(preparedChanges)) return { changed: false, evidence: current };
    if (!this.registry || !canonicalInstant(input.reservedAt)
        || !canonicalInstant(input.finalizedAt) || input.finalizedAt < input.reservedAt)
      throw new ClayError("E_TARGET_AUTHORITY_INVALID", "target commit timing is invalid");
    this.driver.runAuthorized(() =>
      target.reserveProtectionRevision(
        input.operationId, input.reservedAt, expected.data, fingerprint));
    try {
      const evidence = this.driver.runAuthorized(() =>
        target.commitReservedProtectionRevision({
          operationId: input.operationId,
          expectedTarget: expected.data,
          finalizedAt: input.finalizedAt,
          changes: preparedChanges,
          requestSha256: fingerprint,
          mutate: input.mutate,
          registry: this.registry!,
        }));
      return { changed: true, evidence };
    } catch (error) {
      try {
        this.driver.runAuthorized(() =>
          target.abandonProtectionRevision(input.operationId, input.finalizedAt));
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
