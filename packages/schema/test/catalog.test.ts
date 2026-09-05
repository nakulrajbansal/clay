import { describe, expect, it } from "vitest";
import {
  AppCatalogSnapshotV1,
  CatalogCasPublicationV1,
  ImmutableAppGenerationV1,
  TargetEvidenceV1,
  WriteFenceV1,
} from "../src/index";

const id = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;
const digest = (char: string): string => `sha256:${char.repeat(64)}`;
const entry = {
  appInstanceId: id("app", "a"),
  displayName: "Field Service",
  activeGenerationId: id("gen", "b"),
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

describe("authoritative catalog boundary schemas", () => {
  it("accepts only a strict current catalog snapshot and write fence", () => {
    expect(AppCatalogSnapshotV1.parse(snapshot)).toEqual(snapshot);
    expect(WriteFenceV1.parse(fence)).toEqual(fence);
    expect(AppCatalogSnapshotV1.safeParse({ ...snapshot, cacheHint: true }).success).toBe(false);
    expect(WriteFenceV1.safeParse({ ...fence, writeEpoch: "03" }).success).toBe(false);
    expect(WriteFenceV1.safeParse({ ...fence, leaseId: id("lease", "1") }).success).toBe(false);
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
