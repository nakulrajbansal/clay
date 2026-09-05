import { describe, expect, it } from "vitest";
import { deriveDeviceState, type DeviceProtectionInput } from "../src/index";

const id = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;
const target = {
  appInstanceId: id("app", "a"), activeGenerationId: id("gen", "b"),
  lineageEpoch: "1", stateRevision: "2", stateDigest: `sha256:${"c".repeat(64)}`,
};

function baseline(overrides: Partial<DeviceProtectionInput> = {}): DeviceProtectionInput {
  return {
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
    ...overrides,
  };
}

describe("deriveDeviceState", () => {
  it("returns checking while any authoritative check is incomplete", () => {
    expect(deriveDeviceState(baseline({ checksComplete: false }))).toEqual({
      state: "checking", reasonCode: null,
    });
  });

  it.each(["restricted", "denied", "thrown", "locked", "corrupt", "quota", "attach", "unclassified"] as const)(
    "fails closed for expected-store failure %s", expectedStoreFailure => {
      expect(deriveDeviceState(baseline({ expectedStoreFailure }))).toEqual({
        state: "locked_or_unknown", reasonCode: "expected_store_failure",
      });
    });

  it("fails closed when any authoritative inventory is unreadable", () => {
    expect(deriveDeviceState(baseline({ catalogReadable: false, catalogAppCount: null }))).toEqual({
      state: "locked_or_unknown", reasonCode: "catalog_unavailable",
    });
    expect(deriveDeviceState(baseline({ namespaceInventoryReadable: false, durableNamespaceCount: null }))).toEqual({
      state: "locked_or_unknown", reasonCode: "inventory_unavailable",
    });
  });

  it("requires the displayed-loss-boundary choice before Temporary", () => {
    const fresh = baseline({
      catalogAppCount: 0, durableNamespaceCount: 0, capability: "unsupported",
      storeOpen: "no", persisted: "no", target: null, checkpoint: { state: "none", target: null },
    });
    expect(deriveDeviceState(fresh)).toEqual({
      state: "temporary_choice_required", reasonCode: "temporary_choice_required",
    });
    expect(deriveDeviceState({ ...fresh, userChoice: "accepted_temporary_after_loss_boundary" })).toEqual({
      state: "temporary", reasonCode: null,
    });
  });

  it("does not treat unsupported storage with existing authority as Temporary", () => {
    expect(deriveDeviceState(baseline({ capability: "unsupported", storeOpen: "no" }))).toEqual({
      state: "locked_or_unknown", reasonCode: "temporary_ineligible",
    });
  });

  it("withholds protection until transaction, persistence, and checkpoint evidence pass", () => {
    expect(deriveDeviceState(baseline({ transactionCertified: false }))).toEqual({
      state: "locked_or_unknown", reasonCode: "transaction_uncertified",
    });
    expect(deriveDeviceState(baseline({ persisted: "unknown" }))).toEqual({
      state: "needs_protection", reasonCode: "persistence_unconfirmed",
    });
    expect(deriveDeviceState(baseline({ checkpoint: { state: "in_progress", target } }))).toEqual({
      state: "checkpointing", reasonCode: null,
    });
    expect(deriveDeviceState(baseline({ checkpoint: { state: "stale", target } }))).toEqual({
      state: "needs_protection", reasonCode: "checkpoint_stale",
    });
  });

  it("requires exact target equality for Protected on this device", () => {
    const mismatches = [
      [{ ...target, appInstanceId: id("app", "d") }, "checkpoint_stale"],
      [{ ...target, activeGenerationId: id("gen", "d") }, "generation_not_selected"],
      [{ ...target, lineageEpoch: "3" }, "checkpoint_stale"],
      [{ ...target, stateRevision: "3" }, "checkpoint_stale"],
      [{ ...target, stateDigest: `sha256:${"d".repeat(64)}` }, "checkpoint_stale"],
    ] as const;
    for (const [other, reasonCode] of mismatches) {
      expect(deriveDeviceState(baseline({ checkpoint: { state: "valid", target: other } }))).toEqual({
        state: "needs_protection", reasonCode,
      });
    }
    expect(deriveDeviceState(baseline())).toEqual({
      state: "protected_on_device", reasonCode: null,
    });
  });

  it("fails closed for malformed target identity and contradictory inventory", () => {
    const malformed = { ...target, stateDigest: "sha256:not-a-digest" };
    expect(deriveDeviceState(baseline({
      target: malformed as typeof target,
      checkpoint: { state: "valid", target: malformed as typeof target },
    }))).toEqual({ state: "locked_or_unknown", reasonCode: "inventory_unavailable" });
    expect(deriveDeviceState(baseline({ catalogAppCount: 0 }))).toEqual({
      state: "locked_or_unknown", reasonCode: "inventory_unavailable",
    });
    expect(deriveDeviceState(baseline({ durableNamespaceCount: 0 }))).toEqual({
      state: "locked_or_unknown", reasonCode: "inventory_unavailable",
    });
  });

  it("does not show checkpoint progress for a missing or different target", () => {
    expect(deriveDeviceState(baseline({
      checkpoint: { state: "in_progress", target: null } as unknown as DeviceProtectionInput["checkpoint"],
    }))).toEqual({ state: "locked_or_unknown", reasonCode: "inventory_unavailable" });
    expect(deriveDeviceState(baseline({ checkpoint: {
      state: "in_progress", target: { ...target, stateRevision: "3" },
    } }))).toEqual({ state: "needs_protection", reasonCode: "checkpoint_stale" });
    expect(deriveDeviceState(baseline({ checkpoint: {
      state: "in_progress", target: { ...target, activeGenerationId: id("gen", "d") },
    } }))).toEqual({ state: "needs_protection", reasonCode: "generation_not_selected" });
  });
});
