import { DeviceProtectionInputV1, DeviceStateResultV1 } from "@clay/schema";
import type {
  CheckpointObservationV1 as SchemaCheckpointObservationV1,
  DeviceProtectionInputV1 as SchemaDeviceProtectionInputV1,
  DeviceState, DurableStoreCapability, ExpectedStoreFailure,
  ProtectionReasonCode, TargetIdentityV1, TemporaryUserChoice,
} from "@clay/schema";
export { DeviceProtectionInputV1, DeviceStateResultV1 };
export type {
  DeviceState, DurableStoreCapability, ExpectedStoreFailure,
  ProtectionReasonCode, TemporaryUserChoice,
} from "@clay/schema";

export type DeviceStateResult = DeviceStateResultV1;
export type CheckpointObservation = SchemaCheckpointObservationV1;
export type DeviceProtectionInput = SchemaDeviceProtectionInputV1;

function validCount(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0;
}

export function targetIdentityEquals(
  left: TargetIdentityV1 | null,
  right: TargetIdentityV1 | null,
): boolean {
  return left !== null && right !== null
    && left.appInstanceId === right.appInstanceId
    && left.activeGenerationId === right.activeGenerationId
    && left.lineageEpoch === right.lineageEpoch
    && left.stateRevision === right.stateRevision
    && left.stateDigest === right.stateDigest;
}

export function deriveDeviceState(input: DeviceProtectionInput): DeviceStateResult {
  const parsed = DeviceProtectionInputV1.safeParse(input);
  if (!parsed.success)
    return { state: "locked_or_unknown", reasonCode: "inventory_unavailable" };
  const observed = parsed.data;

  if (observed.expectedStoreFailure !== null)
    return { state: "locked_or_unknown", reasonCode: "expected_store_failure" };
  if (!observed.catalogReadable)
    return { state: "locked_or_unknown", reasonCode: "catalog_unavailable" };
  if (!observed.namespaceInventoryReadable || !observed.jobInventoryReadable)
    return { state: "locked_or_unknown", reasonCode: "inventory_unavailable" };
  if (!observed.checksComplete) return { state: "checking", reasonCode: null };

  const counts = [
    observed.catalogAppCount, observed.durableNamespaceCount, observed.pendingOperationCount,
  ];
  if (!counts.every(validCount))
    return { state: "locked_or_unknown", reasonCode: "inventory_unavailable" };
  const exactZeroInventory = counts.every(value => value === 0);

  if (observed.capability === "unsupported" || observed.capability === "non_persistent") {
    if (!exactZeroInventory)
      return { state: "locked_or_unknown", reasonCode: "temporary_ineligible" };
    return observed.userChoice === "accepted_temporary_after_loss_boundary"
      ? { state: "temporary", reasonCode: null }
      : { state: "temporary_choice_required", reasonCode: "temporary_choice_required" };
  }
  if (observed.capability !== "supported" || observed.storeOpen !== "yes")
    return { state: "locked_or_unknown", reasonCode: "store_unavailable" };
  if (!observed.transactionCertified)
    return { state: "locked_or_unknown", reasonCode: "transaction_uncertified" };
  if (observed.persisted !== "yes")
    return { state: "needs_protection", reasonCode: "persistence_unconfirmed" };
  if (observed.target === null || observed.checkpoint.state === "none")
    return { state: "needs_protection", reasonCode: "checkpoint_missing" };
  if (observed.checkpoint.state === "in_progress") {
    if (observed.checkpoint.target.activeGenerationId !== observed.target.activeGenerationId)
      return { state: "needs_protection", reasonCode: "generation_not_selected" };
    if (!targetIdentityEquals(observed.checkpoint.target, observed.target))
      return { state: "needs_protection", reasonCode: "checkpoint_stale" };
    return { state: "checkpointing", reasonCode: null };
  }
  if (observed.checkpoint.state === "stale")
    return { state: "needs_protection", reasonCode: "checkpoint_stale" };
  if (observed.checkpoint.state === "invalid")
    return { state: "needs_protection", reasonCode: "checkpoint_invalid" };
  if (observed.checkpoint.state === "generation_not_selected")
    return { state: "needs_protection", reasonCode: "generation_not_selected" };
  if (observed.checkpoint.target?.activeGenerationId !== observed.target.activeGenerationId)
    return { state: "needs_protection", reasonCode: "generation_not_selected" };
  if (!targetIdentityEquals(observed.checkpoint.target, observed.target))
    return { state: "needs_protection", reasonCode: "checkpoint_stale" };
  return { state: "protected_on_device", reasonCode: null };
}
