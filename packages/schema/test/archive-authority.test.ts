import { describe, expect, it } from "vitest";
import {
  ArchiveAuthorityEvidenceV1,
  ArchiveManifestV5,
} from "../src/catalog";

const id = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;
const digest = (char: string): string => `sha256:${char.repeat(64)}`;

const target = {
  appInstanceId: id("app", "a"),
  activeGenerationId: id("gen", "b"),
  lineageEpoch: "0",
  protectionRevision: "0",
  digestSchema: 1 as const,
  stateSha256: digest("c"),
};
const exportedAt = "2026-09-05T20:00:00.000Z";
const binding = {
  format: 5 as const,
  app: "Field Service",
  exportedAt,
  tables: 1,
  versions: 2,
  attachments: { count: 0, bytes: 0 },
  userDb: { bytes: 10, sha256: digest("d") },
  systemDb: { bytes: 20, sha256: digest("e") },
};
const descriptor = {
  schema: 1 as const,
  generationId: target.activeGenerationId,
  target,
  namespaceId: id("ns", "f"),
  sourceArchiveSha256: null,
  sourceProvenanceId: null,
  sealedAt: exportedAt,
  readBackAt: exportedAt,
};
const catalogEntry = {
  appInstanceId: target.appInstanceId,
  displayName: "Field Service",
  activeGenerationId: target.activeGenerationId,
  journalGenesisGenerationId: target.activeGenerationId,
  journalGenesisLineageEpoch: target.lineageEpoch,
  journalGenesisProtectionRevision: target.protectionRevision,
  journalGenesisStateSha256: target.stateSha256,
  currentLineageEpoch: target.lineageEpoch,
  lineageEpochHighWater: target.lineageEpoch,
  currentProtectionRevision: target.protectionRevision,
  revisionHighWater: target.protectionRevision,
  digestSchema: 1 as const,
  stateSha256: target.stateSha256,
  tombstoned: false as const,
};
const evidence = {
  schema: 1 as const,
  binding,
  target,
  merkle: { schema: 1 as const, stateSha256: target.stateSha256, leafCount: 42 },
  targetAuthority: {
    schema: 1 as const,
    header: {
      schema: 1 as const,
      appInstanceId: target.appInstanceId,
      activeGenerationId: target.activeGenerationId,
      lineageEpoch: target.lineageEpoch,
      lineageEpochHighWater: target.lineageEpoch,
      protectionRevision: target.protectionRevision,
      protectionRevisionHighWater: target.protectionRevision,
      digestSchema: 1 as const,
    },
    revisions: [],
  },
  catalogAuthority: {
    schema: 1 as const,
    authorityIncarnationId: id("auth", "g"),
    catalogGeneration: "1",
    writeEpoch: "0",
    selectedAppInstanceId: target.appInstanceId,
    entry: catalogEntry,
    generations: [{
      schema: 1 as const,
      operationId: id("op", "h"),
      descriptor,
    }],
    leases: [],
    revisionReservations: [],
    generationEvents: [{
      schema: 1 as const,
      catalogGeneration: "1",
      eventKind: "app_seed" as const,
      appInstanceId: target.appInstanceId,
      operationId: id("op", "h"),
      writeEpoch: "0",
      at: exportedAt,
      target,
    }],
  },
};

const manifest = {
  format: 5 as const,
  app: binding.app,
  exported_at: binding.exportedAt,
  tables: binding.tables,
  versions: binding.versions,
  attachments: binding.attachments,
  files: {
    userDb: binding.userDb,
    systemDb: binding.systemDb,
    authority: { bytes: 30, sha256: digest("f") },
  },
};

describe("archive format 5 authority schemas", () => {
  it("accepts one strict complete authority envelope and manifest", () => {
    expect(ArchiveAuthorityEvidenceV1.parse(evidence)).toEqual(evidence);
    expect(ArchiveManifestV5.parse(manifest)).toEqual(manifest);
  });

  it("rejects aliases, unknown fields, and structurally incomplete authority history", () => {
    expect(ArchiveAuthorityEvidenceV1.safeParse({
      ...evidence,
      target: { ...target, stateRevision: target.protectionRevision },
    }).success).toBe(false);
    expect(ArchiveAuthorityEvidenceV1.safeParse({
      ...evidence,
      targetAuthority: { ...evidence.targetAuthority, revisions: [{ revision: "1" }] },
    }).success).toBe(false);
    expect(ArchiveManifestV5.safeParse({
      ...manifest,
      authorityTrusted: true,
    }).success).toBe(false);
  });
});
