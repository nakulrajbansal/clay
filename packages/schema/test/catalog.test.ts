import { describe, expect, it } from "vitest";
import {
  AppCatalogSnapshotV1,
  CatalogCasPublicationV1,
  CatalogGenerationEventV1,
  CatalogReservationRecoveryV1,
  CatalogRevisionReservationV1,
  ImmutableAppGenerationV1,
  TargetAuthorityHeaderV1,
  TargetEvidenceV1,
  WriteFenceV1,
} from "../src/catalog";

const id = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;
const digest = (char: string): string => `sha256:${char.repeat(64)}`;
const entry = {
  appInstanceId: id("app", "a"),
  displayName: "Field Service",
  activeGenerationId: id("gen", "b"),
  journalGenesisGenerationId: id("gen", "b"),
  journalGenesisLineageEpoch: "2",
  journalGenesisProtectionRevision: "7",
  journalGenesisStateSha256: digest("c"),
  currentLineageEpoch: "2",
  lineageEpochHighWater: "4",
  currentProtectionRevision: "7",
  revisionHighWater: "9",
  digestSchema: 1 as const,
  stateSha256: digest("c"),
  tombstoned: false as const,
};
const snapshot = {
  schema: 1 as const,
  authorityIncarnationId: id("auth", "d"),
  catalogGeneration: "12",
  selectedAppInstanceId: entry.appInstanceId,
  entries: [entry],
  writeEpoch: "3",
};

const fence = {
  authorityIncarnationId: snapshot.authorityIncarnationId,
  writeEpoch: snapshot.writeEpoch,
  leaseId: id("lease", "e"),
  releaseId: id("rel", "f"),
};
const targetEvidence = {
  appInstanceId: entry.appInstanceId,
  activeGenerationId: entry.activeGenerationId,
  lineageEpoch: entry.currentLineageEpoch,
  protectionRevision: entry.currentProtectionRevision,
  digestSchema: 1 as const,
  stateSha256: entry.stateSha256,
};

describe("authoritative app catalog and write-fence schemas", () => {
  it("binds target-owned current values beneath non-reusable high-water marks", () => {
    const header = {
      schema: 1 as const,
      appInstanceId: id("app", "a"),
      activeGenerationId: id("gen", "b"),
      lineageEpoch: "4",
      lineageEpochHighWater: "6",
      protectionRevision: "9",
      protectionRevisionHighWater: "12",
      digestSchema: 1 as const,
    };
    expect(TargetAuthorityHeaderV1.parse(header)).toEqual(header);
    expect(TargetAuthorityHeaderV1.safeParse({
      ...header, lineageEpoch: "7",
    }).success).toBe(false);
    expect(TargetAuthorityHeaderV1.safeParse({
      ...header, protectionRevision: "13",
    }).success).toBe(false);
    expect(TargetAuthorityHeaderV1.safeParse({
      ...header, stateSha256: `sha256:${"1".repeat(64)}`,
    }).success).toBe(false);
  });

  it("accepts only a strict current catalog snapshot and write fence", () => {
    expect(AppCatalogSnapshotV1.parse(snapshot)).toEqual(snapshot);
    expect(WriteFenceV1.parse(fence)).toEqual(fence);
    expect(AppCatalogSnapshotV1.safeParse({ ...snapshot, cacheHint: true }).success).toBe(false);
    expect(WriteFenceV1.safeParse({ ...fence, writeEpoch: "03" }).success).toBe(false);
    expect(WriteFenceV1.safeParse({ ...fence, leaseId: id("lease", "1") }).success).toBe(false);
  });

  it("binds every catalog generation advance to one typed event", () => {
    const event = {
      schema: 1 as const,
      catalogGeneration: "13",
      eventKind: "revision_reserved" as const,
      appInstanceId: entry.appInstanceId,
      operationId: id("op", "h"),
      writeEpoch: fence.writeEpoch,
      at: "2026-09-05T00:00:00.000Z",
      target: null,
    };
    expect(CatalogGenerationEventV1.parse(event)).toEqual(event);
    expect(CatalogGenerationEventV1.safeParse({
      ...event, eventKind: "lease_issued", operationId: event.operationId,
    }).success).toBe(false);
    expect(CatalogGenerationEventV1.safeParse({
      ...event, at: "1970-01-01T01:03:20.000+01:00",
    }).success).toBe(false);
    const seed = {
      ...event,
      eventKind: "app_seed" as const,
      target: {
        appInstanceId: entry.appInstanceId,
        activeGenerationId: entry.journalGenesisGenerationId,
        lineageEpoch: entry.journalGenesisLineageEpoch,
        protectionRevision: entry.journalGenesisProtectionRevision,
        digestSchema: entry.digestSchema,
        stateSha256: entry.journalGenesisStateSha256,
      },
    };
    expect(CatalogGenerationEventV1.parse(seed)).toEqual(seed);
    expect(CatalogGenerationEventV1.safeParse({ ...seed, target: null }).success).toBe(false);
  });

  it("rejects impossible high-water, duplicate, or missing-selection catalog state", () => {
    expect(AppCatalogSnapshotV1.safeParse({
      ...snapshot,
      entries: [{ ...entry, currentProtectionRevision: "10" }],
    }).success).toBe(false);
    expect(AppCatalogSnapshotV1.safeParse({
      ...snapshot,
      entries: [{ ...entry, currentLineageEpoch: "5" }],
    }).success).toBe(false);
    expect(AppCatalogSnapshotV1.safeParse({
      ...snapshot,
      entries: [entry, { ...entry, displayName: "Duplicate" }],
    }).success).toBe(false);
    expect(AppCatalogSnapshotV1.safeParse({
      ...snapshot,
      selectedAppInstanceId: id("app", "g"),
    }).success).toBe(false);
  });

  it("validates a strict post-CAS publication without accepting target aliases", () => {
    const publication = {
      schema: 1 as const,
      authorityIncarnationId: snapshot.authorityIncarnationId,
      catalogGeneration: "13",
      selectedAppInstanceId: entry.appInstanceId,
      publishedTarget: targetEvidence,
    };
    expect(CatalogCasPublicationV1.parse(publication)).toEqual(publication);
    expect(CatalogCasPublicationV1.safeParse({
      ...publication,
      publishedTarget: { ...publication.publishedTarget, stateRevision: "7" },
    }).success).toBe(false);
  });

  it("binds every CAS publication to its selected target app", () => {
    const base = {
      schema: 1 as const,
      authorityIncarnationId: snapshot.authorityIncarnationId,
      catalogGeneration: "13",
      publishedTarget: targetEvidence,
    };
    expect(CatalogCasPublicationV1.safeParse({
      ...base, selectedAppInstanceId: id("app", "g"),
    }).success).toBe(false);
    expect(CatalogCasPublicationV1.safeParse({
      ...base, selectedAppInstanceId: null,
    }).success).toBe(false);
  });

  it("binds a catalog revision reservation to one fenced target request", () => {
    const reservation = {
      schema: 1 as const,
      authorityIncarnationId: snapshot.authorityIncarnationId,
      reservedCatalogGeneration: "13",
      finalizedCatalogGeneration: null,
      writeEpoch: fence.writeEpoch,
      leaseId: fence.leaseId,
      releaseId: fence.releaseId,
      finalizedWriteEpoch: null,
      finalizedLeaseId: null,
      finalizedReleaseId: null,
      appInstanceId: entry.appInstanceId,
      activeGenerationId: entry.activeGenerationId,
      lineageEpoch: entry.currentLineageEpoch,
      revision: "8",
      operationId: id("op", "h"),
      expectedProtectionRevision: entry.currentProtectionRevision,
      expectedStateSha256: entry.stateSha256,
      requestSha256: digest("d"),
      state: "reserved" as const,
      publishedActiveGenerationId: null,
      publishedLineageEpoch: null,
      stateSha256: null,
      reservedAt: "2026-09-05T12:00:00.000Z",
      finalizedAt: null,
    };
    expect(CatalogRevisionReservationV1.parse(reservation)).toEqual(reservation);
    const committed = {
      ...reservation,
      finalizedCatalogGeneration: "14",
      state: "committed" as const,
      finalizedWriteEpoch: fence.writeEpoch,
      finalizedLeaseId: fence.leaseId,
      finalizedReleaseId: fence.releaseId,
      publishedActiveGenerationId: entry.activeGenerationId,
      publishedLineageEpoch: entry.currentLineageEpoch,
      stateSha256: digest("e"),
      finalizedAt: "2026-09-05T12:00:01.000Z",
    };
    expect(CatalogRevisionReservationV1.parse(committed)).toEqual(committed);
    expect(CatalogRevisionReservationV1.safeParse({
      ...reservation,
      expectedProtectionRevision: reservation.revision,
    }).success).toBe(false);
    expect(CatalogRevisionReservationV1.safeParse({
      ...reservation,
      state: "committed",
      stateSha256: digest("e"),
    }).success).toBe(false);
    expect(CatalogRevisionReservationV1.safeParse({
      ...reservation,
      leaseId: id("lease", "1"),
    }).success).toBe(false);
    const recoveryFence = {
      ...fence,
      writeEpoch: "4",
      leaseId: id("lease", "g"),
      releaseId: id("rel", "h"),
    };
    const abandoned = {
      ...reservation,
      finalizedCatalogGeneration: "14",
      finalizedWriteEpoch: recoveryFence.writeEpoch,
      finalizedLeaseId: recoveryFence.leaseId,
      finalizedReleaseId: recoveryFence.releaseId,
      state: "abandoned" as const,
      finalizedAt: "2026-09-05T12:00:01.000Z",
    };
    const recovery = {
      schema: 1 as const,
      catalogGeneration: "14",
      fence: recoveryFence,
      abandonedReservation: abandoned,
    };
    expect(CatalogReservationRecoveryV1.parse(recovery)).toEqual(recovery);
    expect(CatalogReservationRecoveryV1.safeParse({
      ...recovery,
      fence: { ...recoveryFence, writeEpoch: "5" },
    }).success).toBe(false);
  });

  it("binds a sealed immutable descriptor to the exact published generation", () => {
    const generation = {
      schema: 1 as const,
      generationId: entry.activeGenerationId,
      target: targetEvidence,
      namespaceId: id("ns", "g"),
      sourceArchiveSha256: null,
      sourceProvenanceId: null,
      sealedAt: "2026-09-04T20:00:00.000Z",
      readBackAt: "2026-09-04T20:00:01.000Z",
    };
    expect(TargetEvidenceV1.parse(targetEvidence)).toEqual(targetEvidence);
    expect(ImmutableAppGenerationV1.parse(generation)).toEqual(generation);
    expect(ImmutableAppGenerationV1.safeParse({
      ...generation,
      generationId: id("gen", "h"),
    }).success).toBe(false);
    expect(ImmutableAppGenerationV1.safeParse({
      ...generation,
      readBackAt: "not-an-instant",
    }).success).toBe(false);
  });
});
