import { describe, expect, it } from "vitest";
import {
  ArchiveAuthorityEvidenceV1,
  ArchiveBootstrapEntryV1,
  ArchiveCatalogEntryV1,
  ArchiveCatalogSchemaObjectV1,
  ArchiveManifestV5,
  ArchiveRestoreAsNewIdentityV1,
  ArchiveTargetRequestReceiptV1,
} from "@clay/schema/archive";

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
const authorityIncarnationId = id("auth", "g");
const operationId = id("op", "h");
const catalogEntry = {
  appInstanceId: target.appInstanceId,
  displayName: "Field Service",
  shellId: "field_service",
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
  merkle: {
    schema: 1 as const,
    stateSha256: target.stateSha256,
    leafCount: 42,
    bucketRoots: Array.from({ length: 1024 }, () => digest("c")),
  },
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
    requestReceipts: [],
  },
  catalogAuthority: {
    schema: 1 as const,
    schemaObjects: [{
      schema: 1 as const,
      type: "table" as const,
      name: "catalog_root",
      tableName: "catalog_root",
      sql: "CREATE TABLE catalog_root(singleton INTEGER PRIMARY KEY)",
    }],
    authorityIncarnationId,
    catalogGeneration: "1",
    writeEpoch: "0",
    selectedAppInstanceId: target.appInstanceId,
    entry: catalogEntry,
    entries: [catalogEntry],
    generations: [{
      schema: 1 as const,
      operationId,
      storageKey: "default",
      descriptor,
    }],
    idRegistry: [
      { schema: 1 as const, idValue: authorityIncarnationId,
        idKind: "authority" as const, retainedAt: exportedAt },
      { schema: 1 as const, idValue: target.appInstanceId,
        idKind: "app" as const, retainedAt: exportedAt },
      { schema: 1 as const, idValue: target.activeGenerationId,
        idKind: "generation" as const, retainedAt: exportedAt },
      { schema: 1 as const, idValue: descriptor.namespaceId,
        idKind: "namespace" as const, retainedAt: exportedAt },
      { schema: 1 as const, idValue: operationId,
        idKind: "operation" as const, retainedAt: exportedAt },
    ],
    leases: [],
    requestReceipts: [],
    revisionReservations: [],
    bootstrapManifest: [],
    pendingJobs: [],
    lineageReservations: [],
    backupRecords: [],
    generationEvents: [{
      schema: 1 as const,
      catalogGeneration: "1",
      eventKind: "app_seed" as const,
      appInstanceId: target.appInstanceId,
      operationId,
      writeEpoch: "0",
      at: exportedAt,
      target,
      displayName: "Field Service",
      shellId: "field_service",
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

    const duplicateNamespace = structuredClone(evidence);
    duplicateNamespace.catalogAuthority.generations.push({
      schema: 1,
      operationId: id("op", "u"),
      storageKey: "other",
      descriptor: {
        ...descriptor,
        generationId: id("gen", "v"),
        target: {
          ...target,
          appInstanceId: id("app", "w"),
          activeGenerationId: id("gen", "v"),
        },
      },
    });
    expect(ArchiveAuthorityEvidenceV1.safeParse(duplicateNamespace).success).toBe(false);

    const duplicateOperation = structuredClone(evidence);
    duplicateOperation.catalogAuthority.generations.push({
      schema: 1,
      operationId,
      storageKey: "other",
      descriptor: {
        ...descriptor,
        generationId: id("gen", "v"),
        namespaceId: id("ns", "w"),
        target: {
          ...target,
          appInstanceId: id("app", "w"),
          activeGenerationId: id("gen", "v"),
        },
      },
    });
    expect(ArchiveAuthorityEvidenceV1.safeParse(duplicateOperation).success).toBe(false);
  });

  it("requires the complete target, Merkle, and catalog mirror surfaces", () => {
    const withoutTargetReceipts = structuredClone(evidence);
    delete (withoutTargetReceipts.targetAuthority as Record<string, unknown>).requestReceipts;
    expect(ArchiveAuthorityEvidenceV1.safeParse(withoutTargetReceipts).success).toBe(false);

    const withoutCatalogEntries = structuredClone(evidence);
    delete (withoutCatalogEntries.catalogAuthority as Record<string, unknown>).entries;
    expect(ArchiveAuthorityEvidenceV1.safeParse(withoutCatalogEntries).success).toBe(false);

    const withoutMerkleBuckets = structuredClone(evidence);
    delete (withoutMerkleBuckets.merkle as Record<string, unknown>).bucketRoots;
    expect(ArchiveAuthorityEvidenceV1.safeParse(withoutMerkleBuckets).success).toBe(false);
  });

  it("defines a strict restore-as-new identity handoff", () => {
    const restoreIdentity = {
      schema: 1 as const,
      appInstanceId: id("app", "j"),
      generationId: id("gen", "k"),
      namespaceId: id("ns", "m"),
      operationId: id("op", "n"),
      restoredAt: "2026-09-05T21:00:00.000Z",
    };
    expect(ArchiveRestoreAsNewIdentityV1.parse(restoreIdentity)).toEqual(restoreIdentity);
    expect(ArchiveRestoreAsNewIdentityV1.safeParse({
      ...restoreIdentity,
      preserveSourceIdentity: true,
    }).success).toBe(false);
  });

  it("exports strict current catalog support surfaces from the archive entry", () => {
    expect(ArchiveCatalogEntryV1.parse({ ...catalogEntry, tombstoned: true }))
      .toMatchObject({ shellId: "field_service", tombstoned: true });
    expect(ArchiveCatalogSchemaObjectV1.parse(evidence.catalogAuthority.schemaObjects[0]))
      .toEqual(evidence.catalogAuthority.schemaObjects[0]);
    expect(ArchiveBootstrapEntryV1.parse({
      schema: 1,
      storageKey: "default",
      userFile: "user.db",
      systemFile: "system.db",
      storageKind: "legacy",
      appInstanceId: target.appInstanceId,
      generationId: target.activeGenerationId,
      namespaceId: descriptor.namespaceId,
      operationId,
      displayName: catalogEntry.displayName,
      shellId: catalogEntry.shellId,
      selected: true,
      declaredAt: exportedAt,
    })).toMatchObject({ shellId: "field_service", selected: true });
    expect(ArchiveTargetRequestReceiptV1.parse({
      schema: 1,
      receipt: {
        schema: 1,
        requestId: id("req", "r"),
        operationId,
        appInstanceId: target.appInstanceId,
        activeGenerationId: target.activeGenerationId,
        lineageEpoch: target.lineageEpoch,
        expectedProtectionRevision: target.protectionRevision,
        expectedStateSha256: target.stateSha256,
        requestSha256: digest("a"),
        state: "prepared",
        resultingProtectionRevision: null,
        resultingStateSha256: null,
        responseSha256: null,
        preparedAt: exportedAt,
        invokedAt: null,
        completedAt: null,
      },
      responseJson: null,
    })).toMatchObject({ receipt: { state: "prepared" }, responseJson: null });
  });
});
