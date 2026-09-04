import { describe, expect, it } from "vitest";
import {
  DeviceStateResultV1,
  DeviceProtectionInputV1,
  DurableStoreCapability,
  ExpectedStoreFailure,
  TargetIdentityV1,
  TemporaryEligibilityV1,
  UInt64Decimal,
} from "../src/index";

const id = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;
const target = {
  appInstanceId: id("app", "a"),
  activeGenerationId: id("gen", "b"),
  lineageEpoch: "4",
  stateRevision: "9",
  stateDigest: `sha256:${"c".repeat(64)}`,
};

describe("A/B shared protection schemas", () => {
  it("accepts the complete canonical target identity and rejects aliases or extras", () => {
    expect(TargetIdentityV1.parse(target)).toEqual(target);
    expect(TargetIdentityV1.safeParse({ ...target, protectionRevision: "9" }).success).toBe(false);
    expect(TargetIdentityV1.safeParse({ ...target, stateRevision: "09" }).success).toBe(false);
    expect(TargetIdentityV1.safeParse({ ...target, stateDigest: `sha256:${"C".repeat(64)}` }).success).toBe(false);
  });

  it("enforces canonical unsigned 64-bit decimal strings", () => {
    expect(UInt64Decimal.parse("0")).toBe("0");
    expect(UInt64Decimal.parse("18446744073709551615")).toBe("18446744073709551615");
    for (const value of ["", "00", "-1", "+1", "1.0", "18446744073709551616"])
      expect(UInt64Decimal.safeParse(value).success, value).toBe(false);
  });

  it("accepts Temporary eligibility only for readable exact zero inventories", () => {
    const eligible = {
      schema: 1 as const,
      catalogReadable: true as const,
      catalogAppCount: 0 as const,
      namespaceInventoryReadable: true as const,
      durableNamespaceCount: 0 as const,
      jobInventoryReadable: true as const,
      pendingOperationCount: 0 as const,
      capability: "unsupported" as const,
      userChoice: null,
    };
    expect(TemporaryEligibilityV1.parse(eligible)).toEqual(eligible);
    expect(TemporaryEligibilityV1.safeParse({ ...eligible, catalogAppCount: 1 }).success).toBe(false);
    expect(TemporaryEligibilityV1.safeParse({ ...eligible, catalogReadable: false }).success).toBe(false);
    expect(TemporaryEligibilityV1.safeParse({ ...eligible, capability: "unknown" }).success).toBe(false);
    expect(TemporaryEligibilityV1.safeParse({ ...eligible, userChoice: "accepted_without_warning" }).success).toBe(false);
  });

  it("keeps storage and protection outcomes closed and strict", () => {
    expect(DurableStoreCapability.parse("non_persistent")).toBe("non_persistent");
    expect(DurableStoreCapability.safeParse("best_effort").success).toBe(false);
    expect(ExpectedStoreFailure.parse("attach")).toBe("attach");
    expect(ExpectedStoreFailure.safeParse("timeout_detail").success).toBe(false);
    expect(DeviceStateResultV1.parse({
      state: "locked_or_unknown", reasonCode: "catalog_unavailable",
    })).toEqual({ state: "locked_or_unknown", reasonCode: "catalog_unavailable" });
    expect(DeviceStateResultV1.safeParse({
      state: "locked_or_unknown", reasonCode: "raw_exception", detail: "secret",
    }).success).toBe(false);
    expect(DeviceStateResultV1.safeParse({
      state: "protected_on_device", reasonCode: "checkpoint_stale",
    }).success).toBe(false);
    expect(DeviceStateResultV1.safeParse({
      state: "temporary_choice_required", reasonCode: null,
    }).success).toBe(false);
  });

  it("rejects malformed or self-contradictory protection observations", () => {
    const input = {
      checksComplete: true,
      expectedStoreFailure: null,
      catalogReadable: true,
      catalogAppCount: 1,
      namespaceInventoryReadable: true,
      durableNamespaceCount: 1,
      jobInventoryReadable: true,
      pendingOperationCount: 0,
      capability: "supported",
      userChoice: null,
      storeOpen: "yes",
      transactionCertified: true,
      persisted: "yes",
      target,
      checkpoint: { state: "valid", target },
    } as const;
    expect(DeviceProtectionInputV1.parse(input)).toEqual(input);
    expect(DeviceProtectionInputV1.safeParse({ ...input, catalogAppCount: 0 }).success).toBe(false);
    expect(DeviceProtectionInputV1.safeParse({ ...input, durableNamespaceCount: 0 }).success).toBe(false);
    expect(DeviceProtectionInputV1.safeParse({
      ...input,
      target: { ...target, stateDigest: "sha256:bad" },
    }).success).toBe(false);
    expect(DeviceProtectionInputV1.safeParse({
      ...input, checkpoint: { state: "in_progress", target: null },
    }).success).toBe(false);
    expect(DeviceProtectionInputV1.safeParse({
      ...input, checkpoint: { state: "in_progress", target },
    }).success).toBe(true);
  });
});
