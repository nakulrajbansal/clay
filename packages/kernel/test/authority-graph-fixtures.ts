// Independent physical/archive fixture builder captured before graph switching.
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
import { DeviceCatalog, expectedCatalogSchemaObjects } from "./oracles/device-catalog";
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
} from "./oracles/archive-authority";
import { sha256HexSync } from "../src/state-digest";
import { writeProductionRequestReceipt } from "../src/production-request-journal";
import { StateMerkleIndex } from "../src/state-merkle-index";
import { TargetAuthorityStore } from "../src/target-authority";
import { seededStoreWithDriver } from "./helpers";
import { encodeAuthorityIdBytes } from "../src/production-operation-id";
import { buildAutomaticBackupFileName } from "../src/backup";

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


export { authoritativeArchiveSource, committedAuthorityArchiveSource, appendUnrelatedCatalogApp, rewriteAuthority };
