import { describe, expect, it } from "vitest";
import {
  ArchiveAuthorityEvidenceV1,
  ArchiveManifestV5,
  MAX_ARCHIVE_AUTHORITY_HISTORY_ENTRIES,
  MAX_ARCHIVE_AUTHORITY_TOTAL_ENTRIES,
  type ArchiveAuthorityEvidenceV1 as ArchiveAuthorityEvidence,
  type ArchiveManifestV5 as ArchiveManifest,
} from "@clay/schema/archive";
import { openMemoryDriver, zipRead, zipWrite, type DbDriver } from "../src/index";
import { enumerateCanonicalStateV1 } from "../src/canonical-state";
import { DeviceCatalog, expectedCatalogSchemaObjects } from "../src/device-catalog";
import {
  assertArchiveAuthorityCardinality,
  assertArchiveAuthorityMemberSize,
  exportAuthenticatedAuthorityArchiveV5,
  exportAuthorityArchiveV5,
  importAuthenticatedAuthorityArchive,
  importAuthorityArchive,
  restoreAuthorityArchiveAsNew,
  validateAuthenticatedAuthorityArchiveStage,
  MAX_ARCHIVE_AUTHORITY_BYTES,
} from "../src/archive-authority";
import { sha256HexSync } from "../src/state-digest";
import { writeProductionRequestReceipt } from "../src/production-request-journal";
import { StateMerkleIndex } from "../src/state-merkle-index";
import { TargetAuthorityStore } from "../src/target-authority";
import { seededStoreWithDriver } from "./helpers";

const id = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;
const sha = (bytes: Uint8Array): string => `sha256:${sha256HexSync(bytes)}`;

async function authoritativeArchiveSource() {
  const { store, driver } = await seededStoreWithDriver();
  const registry = store.validationRegistrySnapshot();
  const census = enumerateCanonicalStateV1(driver, registry);
  StateMerkleIndex.createSchema(driver);
  const merkle = StateMerkleIndex.initialize(driver, census.leaves.map(entry => entry.seed));
  const appInstanceId = id("app", "a");
  const generationId = id("gen", "b");
  TargetAuthorityStore.createSchema(driver);
  const target = TargetAuthorityStore.initialize(driver, {
    schema: 1,
    appInstanceId,
    activeGenerationId: generationId,
    lineageEpoch: "0",
    lineageEpochHighWater: "0",
    protectionRevision: "0",
    protectionRevisionHighWater: "0",
    digestSchema: 1,
  });

  driver.exec("ATTACH DATABASE ':memory:' AS catalog");
  DeviceCatalog.initializeFresh(driver);
  const namespaceId = id("ns", "c");
  const operationId = id("op", "d");
  const at = "2026-09-05T20:00:00.000Z";
  for (const [value, kind] of [
    [appInstanceId, "app"], [generationId, "generation"],
    [namespaceId, "namespace"], [operationId, "operation"],
  ] as const) driver.exec(
    "INSERT INTO catalog.id_registry(id_value,id_kind,retained_at) VALUES (?,?,?)",
    [value, kind, at],
  );
  const stateSha256 = target.evidence().stateSha256;
  driver.exec(
    `INSERT INTO catalog.generations(
       generation_id,app_instance_id,namespace_id,storage_key,operation_id,
       lineage_epoch,first_revision,digest_schema,state_sha256,
       source_archive_sha256,source_provenance_id,sealed_at,read_back_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [generationId, appInstanceId, namespaceId, "default", operationId,
      "0", "0", 1, stateSha256, null, null, at, at],
  );
  driver.exec(
    `INSERT INTO catalog.app_entries(
       app_instance_id,display_name,shell_id,active_generation_id,
       journal_genesis_generation_id,journal_genesis_lineage_epoch,
       journal_genesis_protection_revision,journal_genesis_state_sha256,
       current_lineage_epoch,lineage_epoch_high_water,current_protection_revision,
       revision_high_water,digest_schema,state_sha256,tombstoned
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
    [appInstanceId, "Field Service", "field_service", generationId, generationId, "0", "0", stateSha256,
      "0", "0", "0", "0", 1, stateSha256],
  );
  driver.exec(
    "UPDATE catalog.catalog_root SET selected_app_instance_id=?,catalog_generation='1' WHERE singleton=1",
    [appInstanceId],
  );
  driver.exec(
    `INSERT INTO catalog.catalog_generation_events(
       catalog_generation,event_kind,app_instance_id,operation_id,write_epoch,at,display_name,shell_id,
       target_generation_id,target_lineage_epoch,target_protection_revision,
       target_digest_schema,target_state_sha256
     ) VALUES ('1','app_seed',?,?,'0',?,?,?,?,?,?,?,?)`,
    [appInstanceId, operationId, at, "Field Service", "field_service",
      generationId, "0", "0", 1, stateSha256],
  );
  const catalog = DeviceCatalog.openExisting(driver);
  const beforeLease = catalog.snapshot();
  const fence = catalog.acquireWriteLease({
    expectedAuthorityIncarnationId: beforeLease.authorityIncarnationId,
    expectedCatalogGeneration: beforeLease.catalogGeneration,
    expectedWriteEpoch: beforeLease.writeEpoch,
    releaseId: id("rel", "e"),
    nowMs: Date.parse("2026-09-05T20:01:00.000Z"),
    ttlMs: 60_000,
  });
  return {
    store,
    driver,
    target,
    merkle,
    catalog,
    fence,
    expectedCatalogGeneration: catalog.snapshot().catalogGeneration,
  };
}

async function committedAuthorityArchiveSource() {
  const source = await authoritativeArchiveSource();
  const preCommitLegacy = await source.store.exportArchive("Field Service");
  const expectedTarget = source.target.evidence();
  const registry = source.store.validationRegistrySnapshot();
  const census = enumerateCanonicalStateV1(source.driver, registry);
  const table = registry.get("projects")!;
  const name = table.columns.find(column => column.name === "name")!;
  const apollo = source.store.query({ from: "projects" })
    .find(record => record.name === "Apollo")!;
  const rowId = String(apollo.id);
  const row = census.leaves.find(entry =>
    entry.source.database === "main" && entry.source.table === "projects"
    && entry.seed.fields.some(field => field.kind === "text" && field.value === "Apollo"))!.seed;
  const fields = row.fields.map(field =>
    field.name === `field/${name.semantic!.fieldId}` && field.kind === "text"
      ? { ...field, value: "Archive committed" } : field);
  const operationId = id("op", "m");
  const requestSha256 = `sha256:${"d".repeat(64)}`;
  const reservedAt = "2026-09-05T20:01:10.000Z";
  const finalizedAt = "2026-09-05T20:01:20.000Z";
  source.target.reserveProtectionRevision(
    operationId, reservedAt, expectedTarget, requestSha256,
  );
  const reservation = source.catalog.reserveSelectedProtectionRevision({
    expectedCatalogGeneration: source.expectedCatalogGeneration,
    expectedTarget,
    operationId,
    requestSha256,
    fence: source.fence,
    nowMs: Date.parse(reservedAt),
  });
  const publishedTarget = source.target.commitReservedProtectionRevision({
    operationId,
    expectedTarget,
    finalizedAt,
    changes: [{ key: row.key, fields }],
    requestSha256,
    mutate: () => source.driver.exec(
      "UPDATE projects SET name = ? WHERE id = ?", ["Archive committed", rowId],
    ),
    registry,
  });
  source.catalog.publishSelectedTarget({
    expectedCatalogGeneration: reservation.reservedCatalogGeneration,
    expectedTarget,
    publishedTarget,
    operationId,
    requestSha256,
    fence: source.fence,
    nowMs: Date.parse(finalizedAt),
  });
  const requestId = id("req", "r");
  const responseJson = JSON.stringify({ operationId, protectionRevision: "1" });
  const responseSha256 = sha(new TextEncoder().encode(responseJson));
  const receiptBase = {
    schema: 1 as const,
    requestId,
    operationId,
    appInstanceId: expectedTarget.appInstanceId,
    activeGenerationId: expectedTarget.activeGenerationId,
    lineageEpoch: expectedTarget.lineageEpoch,
    expectedProtectionRevision: expectedTarget.protectionRevision,
    expectedStateSha256: expectedTarget.stateSha256,
    requestSha256,
    preparedAt: reservedAt,
  };
  source.driver.tx(() => writeProductionRequestReceipt(source.driver, {
    ...receiptBase,
    state: "prepared",
    resultingProtectionRevision: null,
    resultingStateSha256: null,
    responseSha256: null,
    invokedAt: null,
    completedAt: null,
  }, null, null));
  source.driver.tx(() => writeProductionRequestReceipt(source.driver, {
    ...receiptBase,
    state: "invoked",
    resultingProtectionRevision: null,
    resultingStateSha256: null,
    responseSha256: null,
    invokedAt: "2026-09-05T20:01:15.000Z",
    completedAt: null,
  }, null, "prepared"));
  source.driver.tx(() => writeProductionRequestReceipt(source.driver, {
    ...receiptBase,
    state: "committed",
    resultingProtectionRevision: publishedTarget.protectionRevision,
    resultingStateSha256: publishedTarget.stateSha256,
    responseSha256,
    invokedAt: "2026-09-05T20:01:15.000Z",
    completedAt: finalizedAt,
  }, responseJson, "invoked"));
  return { ...source, preCommitLegacy };
}

function appendUnrelatedCatalogApp(
  driver: DbDriver,
  catalog: DeviceCatalog,
): { appInstanceId: string; seedCatalogGeneration: string; catalogGeneration: string } {
  const before = catalog.snapshot();
  const appInstanceId = id("app", "2");
  const generationId = id("gen", "v");
  const namespaceId = id("ns", "w");
  const operationId = id("op", "x");
  const selectionOperationId = id("op", "y");
  const at = "2026-09-05T20:02:00.000Z";
  const stateSha256 = `sha256:${"e".repeat(64)}`;
  const seedCatalogGeneration = String(BigInt(before.catalogGeneration) + 1n);
  const catalogGeneration = String(BigInt(seedCatalogGeneration) + 1n);
  const selected = before.entries.find(entry =>
    entry.appInstanceId === before.selectedAppInstanceId)!;
  driver.tx(() => {
    for (const [value, kind] of [
      [appInstanceId, "app"], [generationId, "generation"],
      [namespaceId, "namespace"], [operationId, "operation"],
      [selectionOperationId, "operation"],
    ] as const) driver.exec(
      "INSERT INTO catalog.id_registry(id_value,id_kind,retained_at) VALUES (?,?,?)",
      [value, kind, at],
    );
    driver.exec(
      `INSERT INTO catalog.generations(
         generation_id,app_instance_id,namespace_id,storage_key,operation_id,
         lineage_epoch,first_revision,digest_schema,state_sha256,
         source_archive_sha256,source_provenance_id,sealed_at,read_back_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [generationId, appInstanceId, namespaceId, "unrelated", operationId,
        "0", "0", 1, stateSha256, null, null, at, at],
    );
    driver.exec(
      `INSERT INTO catalog.app_entries(
         app_instance_id,display_name,shell_id,active_generation_id,
         journal_genesis_generation_id,journal_genesis_lineage_epoch,
         journal_genesis_protection_revision,journal_genesis_state_sha256,
         current_lineage_epoch,lineage_epoch_high_water,current_protection_revision,
         revision_high_water,digest_schema,state_sha256,tombstoned
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      [appInstanceId, "Unrelated", "blank", generationId, generationId, "0", "0", stateSha256,
        "0", "0", "0", "0", 1, stateSha256],
    );
    driver.exec(
      `INSERT INTO catalog.catalog_generation_events(
         catalog_generation,event_kind,app_instance_id,operation_id,write_epoch,at,display_name,shell_id,
         target_generation_id,target_lineage_epoch,target_protection_revision,
         target_digest_schema,target_state_sha256
       ) VALUES (?,'app_seed',?,?,?,?,?,?,?,?,?,?,?)`,
      [seedCatalogGeneration, appInstanceId, operationId, before.writeEpoch, at, "Unrelated", "blank",
        generationId, "0", "0", 1, stateSha256],
    );
    driver.exec(
      `INSERT INTO catalog.catalog_generation_events(
         catalog_generation,event_kind,app_instance_id,operation_id,write_epoch,at,
         display_name,shell_id,target_generation_id,target_lineage_epoch,
         target_protection_revision,target_digest_schema,target_state_sha256
       ) VALUES (?,'app_selected',?,?,?,?,NULL,NULL,?,?,?,?,?)`,
      [catalogGeneration, selected.appInstanceId, selectionOperationId, before.writeEpoch, at,
        selected.activeGenerationId, selected.currentLineageEpoch,
        selected.currentProtectionRevision, selected.digestSchema, selected.stateSha256],
    );
    driver.exec(
      "UPDATE catalog.catalog_root SET selected_app_instance_id=?,catalog_generation=? WHERE singleton=1",
      [selected.appInstanceId, catalogGeneration],
    );
  });
  return { appInstanceId, seedCatalogGeneration, catalogGeneration };
}

function rewriteAuthority(
  archive: Uint8Array,
  mutate: (authority: ArchiveAuthorityEvidence) => void,
  resign = true,
): Uint8Array {
  const parts = zipRead(archive);
  const manifestPart = parts.find(part => part.name === "manifest.json")!;
  const authorityPart = parts.find(part => part.name === "authority.json")!;
  const manifest = ArchiveManifestV5.parse(JSON.parse(new TextDecoder().decode(manifestPart.data)));
  const authority = ArchiveAuthorityEvidenceV1.parse(
    JSON.parse(new TextDecoder().decode(authorityPart.data)),
  );
  mutate(authority);
  const authorityBytes = new TextEncoder().encode(JSON.stringify(authority));
  const nextManifest: ArchiveManifest = resign ? {
    ...manifest,
    files: {
      ...manifest.files,
      authority: { bytes: authorityBytes.byteLength, sha256: sha(authorityBytes) },
    },
  } : manifest;
  return zipWrite(parts.map(part => part.name === "manifest.json"
    ? { ...part, data: new TextEncoder().encode(JSON.stringify(nextManifest)) }
    : part.name === "authority.json" ? { ...part, data: authorityBytes } : part));
}

async function expectRejectedBeforeReplacement(
  archive: Uint8Array,
  expected: RegExp,
): Promise<void> {
  let replacementCalls = 0;
  await expect(importAuthorityArchive(archive, async () => {
    replacementCalls++;
    throw new Error("replacement must not be reached");
  })).rejects.toThrow(expected);
  expect(replacementCalls).toBe(0);
}

describe("archive format 5 authority evidence", () => {
  it("carries global catalog continuity when an unrelated app advances the root", async () => {
    const source = await authoritativeArchiveSource();
    try {
      const unrelated = appendUnrelatedCatalogApp(source.driver, source.catalog);
      const archive = await exportAuthorityArchiveV5(
        await source.store.exportArchive("Field Service"), source.driver,
      );
      const authority = ArchiveAuthorityEvidenceV1.parse(JSON.parse(new TextDecoder().decode(
        zipRead(archive).find(part => part.name === "authority.json")!.data,
      )));
      expect(authority.catalogAuthority.catalogGeneration).toBe(unrelated.catalogGeneration);
      expect(authority.catalogAuthority.generationEvents.map(event => event.catalogGeneration))
        .toEqual(["1", "2", unrelated.seedCatalogGeneration, unrelated.catalogGeneration]);
      expect(authority.catalogAuthority.generationEvents
        .find(event => event.catalogGeneration === unrelated.seedCatalogGeneration)!.appInstanceId)
        .toBe(unrelated.appInstanceId);
      expect(authority.catalogAuthority.generationEvents.at(-1)!.appInstanceId)
        .toBe(source.target.evidence().appInstanceId);
      expect(authority.catalogAuthority.entries.map(entry => entry.appInstanceId).sort())
        .toEqual([source.target.evidence().appInstanceId, unrelated.appInstanceId].sort());
      expect(authority.catalogAuthority.generations.map(generation =>
        generation.descriptor.generationId)).toHaveLength(2);
      expect(authority.catalogAuthority.generations.find(generation =>
        generation.descriptor.target.appInstanceId === unrelated.appInstanceId)?.storageKey)
        .toBe("unrelated");
      const imported = await importAuthorityArchive(archive);
      imported.store.close();
    } finally {
      source.store.close();
    }
  });

  it("carries complete revision history for an unselected sibling app", async () => {
    const source = await committedAuthorityArchiveSource();
    try {
      const unrelated = appendUnrelatedCatalogApp(source.driver, source.catalog);
      let snapshot = source.catalog.selectApp({
        expectedCatalogGeneration: unrelated.catalogGeneration,
        appInstanceId: unrelated.appInstanceId,
        operationId: id("op", "s"),
        fence: source.fence,
        nowMs: Date.parse("2026-09-05T20:01:30.000Z"),
      });
      const sibling = snapshot.entries.find(entry =>
        entry.appInstanceId === unrelated.appInstanceId)!;
      const siblingTarget = {
        appInstanceId: sibling.appInstanceId,
        activeGenerationId: sibling.activeGenerationId,
        lineageEpoch: sibling.currentLineageEpoch,
        protectionRevision: sibling.currentProtectionRevision,
        digestSchema: sibling.digestSchema,
        stateSha256: sibling.stateSha256,
      };
      const requestSha256 = `sha256:${"a".repeat(64)}`;
      const reservation = source.catalog.reserveSelectedProtectionRevision({
        expectedCatalogGeneration: snapshot.catalogGeneration,
        expectedTarget: siblingTarget,
        operationId: id("op", "q"),
        requestSha256,
        fence: source.fence,
        nowMs: Date.parse("2026-09-05T20:01:30.001Z"),
      });
      source.catalog.abandonSelectedProtectionRevision({
        expectedCatalogGeneration: reservation.reservedCatalogGeneration,
        expectedTarget: siblingTarget,
        operationId: reservation.operationId,
        requestSha256,
        fence: source.fence,
        nowMs: Date.parse("2026-09-05T20:01:30.002Z"),
      });
      snapshot = source.catalog.snapshot();
      source.catalog.selectApp({
        expectedCatalogGeneration: snapshot.catalogGeneration,
        appInstanceId: source.target.evidence().appInstanceId,
        operationId: id("op", "t"),
        fence: source.fence,
        nowMs: Date.parse("2026-09-05T20:01:30.003Z"),
      });

      const archive = await exportAuthorityArchiveV5(
        await source.store.exportArchive("Field Service"), source.driver,
      );
      const evidence = ArchiveAuthorityEvidenceV1.parse(JSON.parse(new TextDecoder().decode(
        zipRead(archive).find(part => part.name === "authority.json")!.data,
      )));
      expect(evidence.catalogAuthority.revisionReservations.some(candidate =>
        candidate.appInstanceId === unrelated.appInstanceId
        && candidate.state === "abandoned")).toBe(true);
      const imported = await importAuthorityArchive(archive);
      imported.store.close();

      const orphanedActiveReservation = rewriteAuthority(archive, authority => {
        const siblingEntry = authority.catalogAuthority.entries.find(candidate =>
          candidate.appInstanceId === unrelated.appInstanceId)!;
        const siblingReservation = authority.catalogAuthority.revisionReservations.find(candidate =>
          candidate.appInstanceId === unrelated.appInstanceId)!;
        siblingReservation.state = "reserved";
        siblingReservation.finalizedCatalogGeneration = null;
        siblingReservation.finalizedWriteEpoch = null;
        siblingReservation.finalizedLeaseId = null;
        siblingReservation.finalizedReleaseId = null;
        siblingReservation.publishedActiveGenerationId = null;
        siblingReservation.publishedLineageEpoch = null;
        siblingReservation.stateSha256 = null;
        siblingReservation.finalizedAt = null;
        const finalizationEvent = authority.catalogAuthority.generationEvents.find(event =>
          event.operationId === siblingReservation.operationId
          && event.eventKind === "revision_abandoned")!;
        finalizationEvent.eventKind = "app_metadata";
        finalizationEvent.displayName = siblingEntry.displayName;
        finalizationEvent.shellId = siblingEntry.shellId;
      });
      await expectRejectedBeforeReplacement(
        orphanedActiveReservation, /active revision reservation/i,
      );
    } finally {
      source.store.close();
    }
  });

  it("retains tombstoned app metadata and immutable generation history", async () => {
    const source = await authoritativeArchiveSource();
    try {
      const unrelated = appendUnrelatedCatalogApp(source.driver, source.catalog);
      source.driver.exec(
        "UPDATE catalog.app_entries SET tombstoned=1 WHERE app_instance_id=?",
        [unrelated.appInstanceId],
      );
      const archive = await exportAuthorityArchiveV5(
        await source.store.exportArchive("Field Service"), source.driver,
      );
      const authority = ArchiveAuthorityEvidenceV1.parse(JSON.parse(new TextDecoder().decode(
        zipRead(archive).find(part => part.name === "authority.json")!.data,
      )));
      expect(authority.catalogAuthority.entries.find(entry =>
        entry.appInstanceId === unrelated.appInstanceId)?.tombstoned).toBe(true);
      expect(authority.catalogAuthority.generations.some(generation =>
        generation.descriptor.target.appInstanceId === unrelated.appInstanceId)).toBe(true);
      const staged = await importAuthorityArchive(archive);
      staged.store.close();
    } finally {
      source.store.close();
    }
  });

  it("carries canonical shell metadata and its app_metadata event", async () => {
    const source = await authoritativeArchiveSource();
    try {
      source.catalog.updateSelectedAppMetadata({
        expectedCatalogGeneration: source.catalog.snapshot().catalogGeneration,
        displayName: "Field Operations",
        shellId: "field_operations",
        operationId: id("op", "p"),
        fence: source.fence,
        nowMs: Date.parse("2026-09-05T20:01:30.000Z"),
      });
      const archive = await exportAuthorityArchiveV5(
        await source.store.exportArchive("Field Operations"), source.driver,
      );
      const evidence = ArchiveAuthorityEvidenceV1.parse(JSON.parse(new TextDecoder().decode(
        zipRead(archive).find(part => part.name === "authority.json")!.data,
      )));
      expect(evidence.catalogAuthority.entry).toMatchObject({
        displayName: "Field Operations",
        shellId: "field_operations",
      });
      expect(evidence.catalogAuthority.generationEvents.at(-1)).toMatchObject({
        eventKind: "app_metadata",
        displayName: "Field Operations",
        shellId: "field_operations",
      });
      expect(evidence.catalogAuthority.idRegistry).toContainEqual(expect.objectContaining({
        idValue: id("op", "p"),
        idKind: "operation",
      }));
      const imported = await importAuthorityArchive(archive);
      imported.store.close();
    } finally {
      source.store.close();
    }
  });

  it("rejects an archive display name that diverges from canonical app metadata", async () => {
    const source = await authoritativeArchiveSource();
    try {
      await expect(exportAuthorityArchiveV5(
        await source.store.exportArchive("Forged display name"), source.driver,
      )).rejects.toThrow(/display metadata/i);
    } finally {
      source.store.close();
    }
  });

  it("bounds authority evidence before UTF-8 decode or JSON parsing", () => {
    expect(() => assertArchiveAuthorityMemberSize(MAX_ARCHIVE_AUTHORITY_BYTES))
      .not.toThrow();
    expect(() => assertArchiveAuthorityMemberSize(MAX_ARCHIVE_AUTHORITY_BYTES + 1))
      .toThrow(/32 MiB/i);
    expect(() => assertArchiveAuthorityMemberSize(Number.NaN)).toThrow(/32 MiB/i);
  });

  it("bounds authority history cardinality before schema traversal", () => {
    const raw = {
      targetAuthority: { revisions: new Array(MAX_ARCHIVE_AUTHORITY_HISTORY_ENTRIES + 1) },
      catalogAuthority: {
        generations: [], leases: [], revisionReservations: [], generationEvents: [],
      },
    };
    expect(() => assertArchiveAuthorityCardinality(raw)).toThrow(/entry limit/i);
    expect(() => assertArchiveAuthorityCardinality({
      targetAuthority: null,
      catalogAuthority: raw.catalogAuthority,
    })).not.toThrow();
    expect(() => assertArchiveAuthorityCardinality({
      targetAuthority: null,
      catalogAuthority: {
        ...raw.catalogAuthority,
        generationEvents: new Array(MAX_ARCHIVE_AUTHORITY_HISTORY_ENTRIES + 1),
      },
    })).toThrow(/entry limit/i);
    expect(() => assertArchiveAuthorityCardinality({
      targetAuthority: raw.targetAuthority,
      catalogAuthority: null,
    })).toThrow(/entry limit/i);

    const aggregate = {
      targetAuthority: { revisions: new Array(MAX_ARCHIVE_AUTHORITY_HISTORY_ENTRIES) },
      catalogAuthority: {
        generations: new Array(MAX_ARCHIVE_AUTHORITY_TOTAL_ENTRIES
          - MAX_ARCHIVE_AUTHORITY_HISTORY_ENTRIES),
        leases: new Array(1),
        revisionReservations: [],
        generationEvents: [],
      },
    };
    expect(() => assertArchiveAuthorityCardinality(aggregate)).toThrow(/total entry limit/i);
  });

  it("does not install source authority as a fresh format 5 target", async () => {
    const source = await authoritativeArchiveSource();
    try {
      const archive = await exportAuthorityArchiveV5(
        await source.store.exportArchive("Field Service"), source.driver,
      );
      let replacementCalls = 0;
      await expect(importAuthorityArchive(archive, async () => {
        replacementCalls++;
        throw new Error("replacement must remain unreachable");
      })).rejects.toThrow(/worker-owned target reconstruction/i);
      expect(replacementCalls).toBe(0);
    } finally {
      source.store.close();
    }
  });

  it("restores validated format 5 data under a fresh target and generation identity", async () => {
    const source = await committedAuthorityArchiveSource();
    let restoredStore: Awaited<ReturnType<typeof restoreAuthorityArchiveAsNew>>["store"] | undefined;
    try {
      const archive = await exportAuthorityArchiveV5(
        await source.store.exportArchive("Field Service"), source.driver,
      );
      const identity = {
        schema: 1 as const,
        appInstanceId: id("app", "j"),
        generationId: id("gen", "k"),
        namespaceId: id("ns", "m"),
        operationId: id("op", "n"),
        restoredAt: "2026-09-05T21:00:00.000Z",
      };
      let freshDriver: DbDriver | undefined;
      let installedTarget: unknown = null;
      const restored = await restoreAuthorityArchiveAsNew(archive, identity, async () => {
        freshDriver = await openMemoryDriver();
        return freshDriver;
      }, {
        afterAuthorityReadBack: context => { installedTarget = context.target; },
      });
      restoredStore = restored.store;
      expect(installedTarget).toEqual(restored.target);
      expect(restored.sourceAuthority.evidence.target).toEqual(source.target.evidence());
      expect(restored.target).toEqual({
        appInstanceId: identity.appInstanceId,
        activeGenerationId: identity.generationId,
        lineageEpoch: "0",
        protectionRevision: "0",
        digestSchema: 1,
        stateSha256: source.target.evidence().stateSha256,
      });
      expect(restored.target.appInstanceId).not.toBe(source.target.evidence().appInstanceId);
      expect(restored.generation).toMatchObject({
        operationId: identity.operationId,
        storageKey: identity.generationId,
        descriptor: {
          generationId: identity.generationId,
          namespaceId: identity.namespaceId,
          sourceArchiveSha256: sha(archive),
          target: restored.target,
        },
      });
      expect(restored.store.query({ from: "projects" }))
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: "Archive committed" })]));
      expect(TargetAuthorityStore.open(freshDriver!).evidence()).toEqual(restored.target);
      expect(TargetAuthorityStore.open(freshDriver!).reservations()).toEqual([]);
      expect(StateMerkleIndex.open(freshDriver!).audit().stateSha256)
        .toBe(restored.target.stateSha256);

      let openedForReuse = 0;
      await expect(restoreAuthorityArchiveAsNew(archive, {
        ...identity,
        appInstanceId: source.target.evidence().appInstanceId,
      }, async () => {
        openedForReuse++;
        return openMemoryDriver();
      })).rejects.toThrow(/fresh|source|identity/i);
      expect(openedForReuse).toBe(0);
    } finally {
      restoredStore?.close();
      source.store.close();
    }
  });

  it("refuses the original physical target without overwriting it", async () => {
    const source = await committedAuthorityArchiveSource();
    try {
      const archive = await exportAuthorityArchiveV5(
        await source.store.exportArchive("Field Service"), source.driver,
      );
      const beforeTarget = source.target.evidence();
      const beforeRows = source.store.query({ from: "projects" });
      const originalTarget: DbDriver = {
        exec: source.driver.exec.bind(source.driver),
        select: source.driver.select.bind(source.driver),
        tx: fn => source.driver.tx(fn),
        close: () => undefined,
        snapshot: source.driver.snapshot.bind(source.driver),
        exportDatabases: source.driver.exportDatabases.bind(source.driver),
      };
      await expect(restoreAuthorityArchiveAsNew(archive, {
        schema: 1,
        appInstanceId: id("app", "j"),
        generationId: id("gen", "k"),
        namespaceId: id("ns", "m"),
        operationId: id("op", "n"),
        restoredAt: "2026-09-05T21:00:00.000Z",
      }, async () => originalTarget)).rejects.toThrow(/not physically empty/i);
      expect(source.target.evidence()).toEqual(beforeTarget);
      expect(source.store.query({ from: "projects" })).toEqual(beforeRows);
    } finally {
      source.store.close();
    }
  });

  it("exports the complete target, Merkle count, and selected catalog history under SHA-256 bindings", async () => {
    const source = await authoritativeArchiveSource();
    try {
      const legacy = await source.store.exportArchive("Field Service");
      const archive = await exportAuthorityArchiveV5(legacy, source.driver);
      expect(archive.byteLength).toBeLessThanOrEqual(384 * 1024 * 1024);
      const parts = zipRead(archive);
      expect(parts.map(part => part.name)).toEqual([
        "manifest.json", "authority.json", "user.db", "system.db",
      ]);
      const manifestPart = parts[0]!;
      expect(manifestPart.data.byteLength).toBeLessThanOrEqual(64 * 1024);
      const manifest = ArchiveManifestV5.parse(JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(manifestPart.data),
      ));
      const authorityPart = parts[1]!;
      const authority = ArchiveAuthorityEvidenceV1.parse(JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(authorityPart.data),
      ));
      const target = source.target.evidence();
      const merkle = source.merkle.audit();
      expect(manifest).toMatchObject({ format: 5, app: "Field Service" });
      expect(manifest.files.authority).toEqual({
        bytes: authorityPart.data.byteLength,
        sha256: sha(authorityPart.data),
      });
      expect(manifest.files.userDb.sha256).toBe(sha(parts[2]!.data));
      expect(manifest.files.systemDb.sha256).toBe(sha(parts[3]!.data));
      expect(authority.target).toEqual(target);
      expect(authority.merkle).toEqual({
        schema: 1,
        stateSha256: merkle.stateSha256,
        leafCount: merkle.leafCount,
        bucketRoots: merkle.bucketRoots,
      });
      expect(authority.targetAuthority.revisions).toEqual([]);
      expect(authority.targetAuthority.requestReceipts).toEqual([]);
      expect(authority.catalogAuthority.schemaObjects).toEqual(expectedCatalogSchemaObjects());
      expect(authority.catalogAuthority.entries).toEqual([
        authority.catalogAuthority.entry,
      ]);
      expect(authority.catalogAuthority.idRegistry.length).toBeGreaterThanOrEqual(5);
      expect(authority.catalogAuthority.requestReceipts).toEqual([]);
      expect(authority.catalogAuthority.bootstrapManifest).toEqual([]);
      expect(authority.catalogAuthority.pendingJobs).toEqual([]);
      expect(authority.catalogAuthority.lineageReservations).toEqual([]);
      expect(authority.catalogAuthority.generationEvents.map(event => event.eventKind))
        .toEqual(["app_seed", "lease_issued"]);
      expect(authority.catalogAuthority.generations).toHaveLength(1);
      expect(authority.catalogAuthority.leases).toHaveLength(1);
      expect(JSON.parse(new TextDecoder().decode(zipRead(legacy)[0]!.data)).format).toBe(4);
    } finally {
      source.store.close();
    }
  });

  it("carries and validates mirrored target/catalog reservation history before preview", async () => {
    const source = await committedAuthorityArchiveSource();
    try {
      const archive = await exportAuthorityArchiveV5(
        await source.store.exportArchive("Field Service"), source.driver,
      );
      const authority = ArchiveAuthorityEvidenceV1.parse(JSON.parse(new TextDecoder().decode(
        zipRead(archive).find(part => part.name === "authority.json")!.data,
      )));
      expect(authority.targetAuthority.revisions).toMatchObject([
        { revision: "1", state: "committed", operationId: id("op", "m") },
      ]);
      expect(authority.catalogAuthority.revisionReservations).toMatchObject([
        { revision: "1", state: "committed", operationId: id("op", "m") },
      ]);
      expect(authority.catalogAuthority.generationEvents.map(event => event.eventKind))
        .toEqual(["app_seed", "lease_issued", "revision_reserved", "revision_committed"]);
      expect(authority.targetAuthority.requestReceipts).toMatchObject([{
        receipt: { requestId: id("req", "r"), state: "committed" },
      }]);
      expect(authority.catalogAuthority.requestReceipts).toMatchObject([
        { requestId: id("req", "r"), state: "committed" },
      ]);
      expect(authority.targetAuthority.requestReceipts[0]!.responseJson)
        .toContain(id("op", "m"));

      const imported = await importAuthorityArchive(archive);
      try {
        expect(imported.authority).toMatchObject({
          kind: "format5_internal_consistency",
          checksumConsistent: true,
          evidence: { target: source.target.evidence() },
        });
        expect(imported.store.query({ from: "projects" }))
          .toEqual(expect.arrayContaining([expect.objectContaining({ name: "Archive committed" })]));
      } finally {
        imported.store.close();
      }
    } finally {
      source.store.close();
    }
  });

  it("rejects missing or altered production request receipt mirrors before preview", async () => {
    const source = await committedAuthorityArchiveSource();
    try {
      const archive = await exportAuthorityArchiveV5(
        await source.store.exportArchive("Field Service"), source.driver,
      );
      const missingCatalogMirror = rewriteAuthority(archive, authority => {
        authority.catalogAuthority.requestReceipts = [];
      });
      const alteredResponse = rewriteAuthority(archive, authority => {
        authority.targetAuthority.requestReceipts[0]!.responseJson =
          JSON.stringify({ operationId: "tampered", protectionRevision: "1" });
      });
      const missingBothMirrors = rewriteAuthority(archive, authority => {
        authority.targetAuthority.requestReceipts = [];
        authority.catalogAuthority.requestReceipts = [];
      });
      await expectRejectedBeforeReplacement(missingCatalogMirror, /receipt|mirror|authority/i);
      await expectRejectedBeforeReplacement(alteredResponse, /response|receipt|digest/i);
      await expectRejectedBeforeReplacement(
        missingBothMirrors, /revision request receipt/i,
      );

      source.driver.exec(
        "DELETE FROM catalog.production_request_receipts WHERE request_id = ?",
        [id("req", "r")],
      );
      await expect(exportAuthorityArchiveV5(
        await source.store.exportArchive("Field Service"), source.driver,
      )).rejects.toThrow(/receipt|mirror|authority/i);
    } finally {
      source.store.close();
    }
  });

  it("rejects checksum-consistent Merkle and catalog-schema tampering", async () => {
    const source = await authoritativeArchiveSource();
    try {
      const archive = await exportAuthorityArchiveV5(
        await source.store.exportArchive("Field Service"), source.driver,
      );
      const merkleTamper = rewriteAuthority(archive, authority => {
        authority.merkle.bucketRoots[0] = `sha256:${"f".repeat(64)}`;
      });
      const catalogSchemaTamper = rewriteAuthority(archive, authority => {
        authority.catalogAuthority.schemaObjects[0]!.sql += " /* forged */";
      });
      await expectRejectedBeforeReplacement(merkleTamper, /Merkle|authority|bucket/i);
      await expectRejectedBeforeReplacement(catalogSchemaTamper, /catalog|schema|authority/i);
    } finally {
      source.store.close();
    }
  });

  it("rejects checksum-consistent full catalog history and metadata tampering", async () => {
    const source = await authoritativeArchiveSource();
    try {
      const unrelated = appendUnrelatedCatalogApp(source.driver, source.catalog);
      const archive = await exportAuthorityArchiveV5(
        await source.store.exportArchive("Field Service"), source.driver,
      );
      const missingGeneration = rewriteAuthority(archive, authority => {
        authority.catalogAuthority.generations = authority.catalogAuthority.generations.filter(
          generation => generation.descriptor.target.appInstanceId !== unrelated.appInstanceId,
        );
      });
      const alteredMetadata = rewriteAuthority(archive, authority => {
        const entry = authority.catalogAuthority.entries.find(candidate =>
          candidate.appInstanceId === unrelated.appInstanceId)!;
        entry.displayName = "Forged sibling";
      });
      const staleSelection = rewriteAuthority(archive, authority => {
        const sibling = authority.catalogAuthority.generations.find(generation =>
          generation.descriptor.target.appInstanceId === unrelated.appInstanceId)!;
        const latest = authority.catalogAuthority.generationEvents.at(-1)!;
        latest.appInstanceId = unrelated.appInstanceId;
        latest.target = sibling.descriptor.target;
      });
      const missingRetainedId = rewriteAuthority(archive, authority => {
        authority.catalogAuthority.idRegistry = authority.catalogAuthority.idRegistry.filter(
          retained => retained.idValue !== id("op", "x"),
        );
      });
      for (const candidate of [
        missingGeneration, alteredMetadata, staleSelection, missingRetainedId,
      ]) await expectRejectedBeforeReplacement(candidate, /catalog|generation|metadata|selection|identity/i);
    } finally {
      source.store.close();
    }
  });

  it("rejects an unreferenced retained authority identity", async () => {
    const source = await authoritativeArchiveSource();
    try {
      const archive = await exportAuthorityArchiveV5(
        await source.store.exportArchive("Field Service"), source.driver,
      );
      const unreferencedIdentity = rewriteAuthority(archive, authority => {
        authority.catalogAuthority.idRegistry.push({
          schema: 1,
          idValue: id("op", "q"),
          idKind: "operation",
          retainedAt: "2026-09-05T20:02:30.000Z",
        });
        authority.catalogAuthority.idRegistry.sort((left, right) =>
          left.idValue.localeCompare(right.idValue));
      });
      await expectRejectedBeforeReplacement(
        unreferencedIdentity, /unreferenced retained/i,
      );
    } finally {
      source.store.close();
    }
  });

  it("rejects a forged app_selected target even when the selected app id is unchanged", async () => {
    const source = await authoritativeArchiveSource();
    try {
      appendUnrelatedCatalogApp(source.driver, source.catalog);
      const archive = await exportAuthorityArchiveV5(
        await source.store.exportArchive("Field Service"), source.driver,
      );
      const forgedSelection = rewriteAuthority(archive, authority => {
        const selection = authority.catalogAuthority.generationEvents.at(-1)!;
        if (selection.eventKind !== "app_selected" || selection.target === null)
          throw new Error("expected final app selection event");
        selection.target.stateSha256 = `sha256:${"f".repeat(64)}`;
      });
      await expectRejectedBeforeReplacement(
        forgedSelection, /app selection event/i,
      );
    } finally {
      source.store.close();
    }
  });

  it("rejects a stale target snapshot and a non-current catalog selection", async () => {
    const stale = await committedAuthorityArchiveSource();
    try {
      await expect(exportAuthorityArchiveV5(stale.preCommitLegacy, stale.driver))
        .rejects.toThrow(/current|canonical|target|stale/i);
    } finally {
      stale.store.close();
    }

    const nonCurrent = await authoritativeArchiveSource();
    try {
      const unrelated = appendUnrelatedCatalogApp(nonCurrent.driver, nonCurrent.catalog);
      nonCurrent.driver.tx(() => {
        nonCurrent.driver.exec(
          "DELETE FROM catalog.catalog_generation_events WHERE catalog_generation = ?",
          [unrelated.catalogGeneration],
        );
        nonCurrent.driver.exec(
          "DELETE FROM catalog.id_registry WHERE id_value = ?", [id("op", "y")],
        );
        nonCurrent.driver.exec(
          `UPDATE catalog.catalog_root
           SET selected_app_instance_id=?,catalog_generation=? WHERE singleton=1`,
          [unrelated.appInstanceId, unrelated.seedCatalogGeneration],
        );
      });
      await expect(exportAuthorityArchiveV5(
        await nonCurrent.store.exportArchive("Field Service"), nonCurrent.driver,
      )).rejects.toThrow(/selected|current|target/i);
    } finally {
      nonCurrent.store.close();
    }
  });

  it("revalidates the exact target after collecting every authority mirror", async () => {
    const source = await authoritativeArchiveSource();
    try {
      const legacy = await source.store.exportArchive("Field Service");
      let mutated = false;
      const mutatingDriver: DbDriver = {
        exec: source.driver.exec.bind(source.driver),
        select: (sql, params) => {
          const rows = source.driver.select(sql, params);
          if (!mutated && sql.includes("catalog.production_request_receipts")) {
            mutated = true;
            source.driver.exec(
              `UPDATE sys.target_authority_header
               SET protection_revision='1',protection_revision_high_water='1'
               WHERE singleton=1`,
            );
          }
          return rows;
        },
        tx: fn => source.driver.tx(fn),
        close: () => undefined,
        snapshot: source.driver.snapshot.bind(source.driver),
        exportDatabases: source.driver.exportDatabases.bind(source.driver),
      };
      await expect(exportAuthorityArchiveV5(legacy, mutatingDriver))
        .rejects.toThrow(/current|target|read-back|authority|revision|high-water/i);
      expect(mutated).toBe(true);
    } finally {
      source.store.close();
    }
  });

  it("refuses format 5 while legacy catalog bootstrap state remains", async () => {
    const source = await authoritativeArchiveSource();
    try {
      source.driver.exec(
        `INSERT INTO catalog.legacy_bootstrap_manifest(
           storage_key,user_file,system_file,storage_kind,app_instance_id,generation_id,
           namespace_id,operation_id,display_name,shell_id,selected,declared_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        ["legacy_other", "legacy_other.user.sqlite3", "legacy_other.system.sqlite3", "legacy",
          id("app", "z"), id("gen", "z"), id("ns", "z"), id("op", "z"),
          "Incomplete", "blank", 0, "2026-09-05T20:03:00.000Z"],
      );
      await expect(exportAuthorityArchiveV5(
        await source.store.exportArchive("Field Service"), source.driver,
      )).rejects.toThrow(/bootstrap|incomplete/i);
    } finally {
      source.store.close();
    }
  });

  it("rejects checksum-consistent authority history with a required reservation event missing", async () => {
    const source = await committedAuthorityArchiveSource();
    try {
      const archive = await exportAuthorityArchiveV5(
        await source.store.exportArchive("Field Service"), source.driver,
      );
      const missingReservationEvent = rewriteAuthority(archive, authority => {
        authority.catalogAuthority.generationEvents = authority.catalogAuthority.generationEvents
          .filter(event => event.eventKind !== "revision_reserved");
      });
      await expectRejectedBeforeReplacement(
        missingReservationEvent, /authority|reservation|event/i,
      );
    } finally {
      source.store.close();
    }
  });

  it("rejects a reservation event replaced by unrelated valid event metadata", async () => {
    const source = await committedAuthorityArchiveSource();
    try {
      const archive = await exportAuthorityArchiveV5(
        await source.store.exportArchive("Field Service"), source.driver,
      );
      const replacedReservationEvent = rewriteAuthority(archive, authority => {
        const event = authority.catalogAuthority.generationEvents.find(candidate =>
          candidate.eventKind === "revision_reserved")!;
        event.eventKind = "app_metadata";
        event.displayName = "Field Service";
        event.shellId = "field_service";
      });
      await expectRejectedBeforeReplacement(
        replacedReservationEvent, /reservation event is missing/i,
      );
    } finally {
      source.store.close();
    }
  });

  it("rejects forged concurrent active catalog leases", async () => {
    const source = await authoritativeArchiveSource();
    try {
      const snapshot = source.catalog.snapshot();
      source.catalog.acquireWriteLease({
        expectedAuthorityIncarnationId: snapshot.authorityIncarnationId,
        expectedCatalogGeneration: snapshot.catalogGeneration,
        expectedWriteEpoch: snapshot.writeEpoch,
        releaseId: id("rel", "r"),
        nowMs: Date.parse("2026-09-05T20:02:00.001Z"),
        ttlMs: 60_000,
      });
      const archive = await exportAuthorityArchiveV5(
        await source.store.exportArchive("Field Service"), source.driver,
      );
      const concurrentLeases = rewriteAuthority(archive, authority => {
        authority.catalogAuthority.leases[0]!.revoked = false;
      });
      await expectRejectedBeforeReplacement(
        concurrentLeases, /active catalog lease history/i,
      );
    } finally {
      source.store.close();
    }
  });

  it("rejects a checksum-consistent archive with required catalog lease evidence missing before replacement", async () => {
    const source = await authoritativeArchiveSource();
    try {
      const archive = await exportAuthorityArchiveV5(
        await source.store.exportArchive("Field Service"), source.driver,
      );
      const missingLease = rewriteAuthority(archive, authority => {
        authority.catalogAuthority.leases = [];
      });
      await expectRejectedBeforeReplacement(missingLease, /authority|lease/i);
    } finally {
      source.store.close();
    }
  });

  it("fails closed when required target, catalog, or member evidence is missing", async () => {
    const source = await committedAuthorityArchiveSource();
    try {
      const archive = await exportAuthorityArchiveV5(
        await source.store.exportArchive("Field Service"), source.driver,
      );
      const missingTargetHistory = rewriteAuthority(archive, authority => {
        authority.targetAuthority.revisions = [];
      });
      const missingCatalogHistory = rewriteAuthority(archive, authority => {
        authority.catalogAuthority.revisionReservations = [];
      });
      const missingGeneration = rewriteAuthority(archive, authority => {
        authority.catalogAuthority.generations = [];
      });
      const missingAuthorityMember = zipWrite(
        zipRead(archive).filter(part => part.name !== "authority.json"),
      );
      for (const candidate of [
        missingTargetHistory, missingCatalogHistory, missingGeneration, missingAuthorityMember,
      ]) await expectRejectedBeforeReplacement(
        candidate, /authority|target|catalog|generation|history|member|four/i,
      );
    } finally {
      source.store.close();
    }
  });

  it("rejects malformed authority evidence even when its new checksum is recorded", async () => {
    const source = await authoritativeArchiveSource();
    try {
      const archive = await exportAuthorityArchiveV5(
        await source.store.exportArchive("Field Service"), source.driver,
      );
      const malformed = rewriteAuthority(archive, authority => {
        (authority.target as unknown as Record<string, unknown>).stateRevision =
          authority.target.protectionRevision;
      });
      await expectRejectedBeforeReplacement(malformed, /authority.*malformed|malformed.*authority/i);
    } finally {
      source.store.close();
    }
  });

  it("rejects checksum-consistent target evidence that mismatches canonical database state", async () => {
    const source = await authoritativeArchiveSource();
    try {
      const archive = await exportAuthorityArchiveV5(
        await source.store.exportArchive("Field Service"), source.driver,
      );
      const forgedDigest = `sha256:${"f".repeat(64)}`;
      const mismatched = rewriteAuthority(archive, authority => {
        authority.target.stateSha256 = forgedDigest;
        authority.merkle.stateSha256 = forgedDigest;
        authority.catalogAuthority.entry.stateSha256 = forgedDigest;
        authority.catalogAuthority.entry.journalGenesisStateSha256 = forgedDigest;
        authority.catalogAuthority.generations[0]!.descriptor.target.stateSha256 = forgedDigest;
        const seed = authority.catalogAuthority.generationEvents
          .find(event => event.eventKind === "app_seed")!;
        seed.target!.stateSha256 = forgedDigest;
      });
      await expectRejectedBeforeReplacement(mismatched, /canonical archive state|authority evidence/i);
    } finally {
      source.store.close();
    }
  });

  it("rejects reordered authority history even when checksums are recomputed", async () => {
    const source = await committedAuthorityArchiveSource();
    try {
      const archive = await exportAuthorityArchiveV5(
        await source.store.exportArchive("Field Service"), source.driver,
      );
      const reordered = rewriteAuthority(archive, authority => {
        authority.catalogAuthority.generationEvents = [
          ...authority.catalogAuthority.generationEvents,
        ].reverse();
      });
      await expectRejectedBeforeReplacement(reordered, /reordered|event history/i);
    } finally {
      source.store.close();
    }
  });

  it("detects authority and database tampering before opening a replacement", async () => {
    const source = await authoritativeArchiveSource();
    try {
      const archive = await exportAuthorityArchiveV5(
        await source.store.exportArchive("Field Service"), source.driver,
      );
      const authorityTamper = rewriteAuthority(archive, authority => {
        authority.merkle.leafCount++;
      }, false);
      const databaseTamper = zipWrite(zipRead(archive).map(part => {
        if (part.name !== "user.db") return part;
        const data = new Uint8Array(part.data);
        data[data.byteLength - 1] = data[data.byteLength - 1]! ^ 1;
        return { ...part, data };
      }));
      await expectRejectedBeforeReplacement(authorityTamper, /checksum|authority/i);
      await expectRejectedBeforeReplacement(databaseTamper, /checksum|binding/i);
    } finally {
      source.store.close();
    }
  });

  it("imports format 4 only as explicit legacy input without an authority trust claim", async () => {
    const source = await authoritativeArchiveSource();
    try {
      const legacy = await source.store.exportArchive("Legacy Field Service");
      const imported = await importAuthorityArchive(legacy);
      try {
        expect(imported.manifest.format).toBe(4);
        expect(imported.authority).toEqual({
          kind: "legacy_archive",
          format: 4,
          checksumConsistent: false,
          evidence: null,
        });
        expect(imported.store.query({ from: "projects" })).toHaveLength(3);
      } finally {
        imported.store.close();
      }

      let freshTargetCalls = 0;
      await expect(restoreAuthorityArchiveAsNew(legacy, {
        schema: 1,
        appInstanceId: id("app", "j"),
        generationId: id("gen", "k"),
        namespaceId: id("ns", "m"),
        operationId: id("op", "n"),
        restoredAt: "2026-09-05T21:00:00.000Z",
      }, async () => {
        freshTargetCalls++;
        return openMemoryDriver();
      })).rejects.toThrow(/certified format 5 authority evidence/i);
      expect(freshTargetCalls).toBe(0);
    } finally {
      source.store.close();
    }
  });

  it("authenticates format 5 before archive parsing or fresh-target opening", async () => {
    const source = await authoritativeArchiveSource();
    const key = new Uint8Array(32).map((_, index) => index);
    const keyId = new Uint8Array(16).map((_, index) => 0x10 + index);
    const seriesId = new Uint8Array(16).map((_, index) => 0x20 + index);
    try {
      const legacy = await source.store.exportArchive("Field Service");
      const unsigned = await exportAuthorityArchiveV5(legacy, source.driver);
      const sealed = await exportAuthenticatedAuthorityArchiveV5(legacy, source.driver, {
        backupTrustKey: key,
        keyId,
        seriesId,
        generation: 1n,
      });
      expect(sealed[0]).toBe(0xd1);
      const imported = await importAuthenticatedAuthorityArchive(sealed, hint => {
        expect(hint).toMatchObject({
          authenticationVersion: 1,
          archiveFormat: 5,
          generation: 1n,
        });
        expect(hint.keyId).toEqual(keyId);
        expect(hint.seriesId).toEqual(seriesId);
        return key;
      });
      try {
        expect(imported.manifest.format).toBe(5);
        expect(imported.authority).toMatchObject({
          kind: "authenticated_format5_authority",
          format: 5,
          cryptographicallyAuthenticated: true,
          checksumConsistent: true,
          authentication: { generation: 1n },
        });
      } finally {
        imported.store.close();
      }

      await expect(validateAuthenticatedAuthorityArchiveStage(
        sealed, source.target.evidence(), () => key,
      )).resolves.toEqual({
        schema: 1,
        status: "valid",
        evidence: source.target.evidence(),
        authentication: {
          schema: 1,
          kind: "cose_mac0_hmac_256_256",
          authenticationVersion: 1,
          keyId: "101112131415161718191a1b1c1d1e1f",
          seriesId: "202122232425262728292a2b2c2d2e2f",
          generation: "1",
        },
      });
      await expect(validateAuthenticatedAuthorityArchiveStage(sealed, {
        ...source.target.evidence(),
        protectionRevision: "1",
      }, () => key)).resolves.toEqual({ schema: 1, status: "invalid", evidence: null });

      await expect(importAuthenticatedAuthorityArchive(unsigned, () => key))
        .rejects.toThrow(/COSE|authenticated archive|tag/i);
      const tampered = sealed.slice();
      tampered[tampered.byteLength - 1] = tampered[tampered.byteLength - 1]! ^ 1;
      let freshTargetCalls = 0;
      await expect(importAuthenticatedAuthorityArchive(tampered, () => key, async () => {
        freshTargetCalls++;
        return openMemoryDriver();
      })).rejects.toThrow(/authentication|trusted key/i);
      expect(freshTargetCalls).toBe(0);
      await expect(validateAuthenticatedAuthorityArchiveStage(
        tampered, source.target.evidence(), () => key,
      )).resolves.toEqual({ schema: 1, status: "invalid", evidence: null });
    } finally {
      source.store.close();
    }
  });

  it("keeps format 5 archive authority helpers out of the public kernel API", async () => {
    const publicApi = await import("../src/index");
    expect(publicApi).not.toHaveProperty("exportAuthorityArchiveV5");
    expect(publicApi).not.toHaveProperty("importAuthorityArchive");
  });
});
