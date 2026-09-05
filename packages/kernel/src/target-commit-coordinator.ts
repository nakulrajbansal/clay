import { OperationId, TargetEvidenceV1 } from "@clay/schema";
import type { TargetEvidenceV1 as TargetEvidence } from "@clay/schema";
import { ClayError } from "./errors";
import type { LiveWriteGuard } from "./live-write-guard";
import { StateMerkleIndex, type StateMerkleChange } from "./state-merkle-index";
import { TargetAuthorityStore } from "./target-authority";

export type TargetCommitInput = {
  expectedTarget: TargetEvidence;
  operationId: string;
  reservedAt: string;
  finalizedAt: string;
  changes: StateMerkleChange[];
  mutate: () => void;
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

export class TargetCommitCoordinator {
  constructor(private readonly driver: LiveWriteGuard) {}

  commit(input: TargetCommitInput): TargetCommitResult {
    const expected = TargetEvidenceV1.safeParse(input.expectedTarget);
    if (!expected.success || !OperationId.safeParse(input.operationId).success
        || !Array.isArray(input.changes) || typeof input.mutate !== "function")
      throw new ClayError("E_TARGET_AUTHORITY_INVALID", "target commit input is invalid");
    const target = TargetAuthorityStore.open(this.driver);
    const current = target.evidence();
    if (!sameTarget(current, expected.data))
      throw new ClayError("E_GENERATION_NOT_SELECTED", "expected target is not current");
    const index = StateMerkleIndex.open(this.driver);
    if (!index.wouldChange(input.changes)) return { changed: false, evidence: current };
    throw new ClayError(
      "E_TARGET_AUTHORITY_INVALID",
      "meaningful target commits are not enabled before guarded publication lands",
    );
  }
}
