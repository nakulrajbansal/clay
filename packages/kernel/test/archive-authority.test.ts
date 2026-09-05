import { describe, expect, it } from "vitest";
import {
  ArchiveAuthorityEvidenceV1,
  ArchiveManifestV5,
  MAX_ARCHIVE_AUTHORITY_HISTORY_ENTRIES,
  MAX_ARCHIVE_AUTHORITY_TOTAL_ENTRIES,
  type ArchiveAuthorityEvidenceV1 as ArchiveAuthorityEvidence,
  type ArchiveManifestV5 as ArchiveManifest,
} from "@clay/schema/catalog";
import { zipRead, zipWrite, type DbDriver } from "../src/index";
import { enumerateCanonicalStateV1 } from "../src/canonical-state";
import { DeviceCatalog } from "../src/device-catalog";
import {
  assertArchiveAuthorityCardinality,
  assertArchiveAuthorityMemberSize,
  exportAuthorityArchiveV5,
  importAuthorityArchive,
  MAX_ARCHIVE_AUTHORITY_BYTES,
} from "../src/archive-authority";
import { sha256HexSync } from "../src/state-digest";
import { StateMerkleIndex } from "../src/state-merkle-index";
import { TargetAuthorityStore } from "../src/target-authority";
import { seededStore } from "./helpers";

const id = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;
const sha = (bytes: Uint8Array): string => `sha256:${sha256HexSync(bytes)}`;

async function authoritativeArchiveSource() {
  const store = await seededStore();
  const driver = (store as unknown as { driver: DbDriver }).driver;
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
       app_instance_id,display_name,active_generation_id,
       journal_genesis_generation_id,journal_genesis_lineage_epoch,
       journal_genesis_protection_revision,journal_genesis_state_sha256,
       current_lineage_epoch,lineage_epoch_high_water,current_protection_revision,
       revision_high_water,digest_schema,state_sha256,tombstoned
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
    [appInstanceId, "Field Service", generationId, generationId, "0", "0", stateSha256,
      "0", "0", "0", "0", 1, stateSha256],
  );
  driver.exec(
    "UPDATE catalog.catalog_root SET selected_app_instance_id=?,catalog_generation='1' WHERE singleton=1",
    [appInstanceId],
  );
  driver.exec(
    `INSERT INTO catalog.catalog_generation_events(
       catalog_generation,event_kind,app_instance_id,operation_id,write_epoch,at,
       target_generation_id,target_lineage_epoch,target_protection_revision,
       target_digest_schema,target_state_sha256
     ) VALUES ('1','app_seed',?,?,'0',?,?,?,?,?,?)`,
    [appInstanceId, operationId, at, generationId, "0", "0", 1, stateSha256],
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
  return source;
}

function appendUnrelatedCatalogApp(
  driver: DbDriver,
  catalog: DeviceCatalog,
): { appInstanceId: string; catalogGeneration: string } {
  const before = catalog.snapshot();
  const appInstanceId = id("app", "u");
  const generationId = id("gen", "v");
  const namespaceId = id("ns", "w");
  const operationId = id("op", "x");
  const at = "2026-09-05T20:02:00.000Z";
  const stateSha256 = `sha256:${"e".repeat(64)}`;
  const catalogGeneration = String(BigInt(before.catalogGeneration) + 1n);
  driver.tx(() => {
    for (const [value, kind] of [
      [appInstanceId, "app"], [generationId, "generation"],
      [namespaceId, "namespace"], [operationId, "operation"],
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
         app_instance_id,display_name,active_generation_id,
         journal_genesis_generation_id,journal_genesis_lineage_epoch,
         journal_genesis_protection_revision,journal_genesis_state_sha256,
         current_lineage_epoch,lineage_epoch_high_water,current_protection_revision,
         revision_high_water,digest_schema,state_sha256,tombstoned
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      [appInstanceId, "Unrelated", generationId, generationId, "0", "0", stateSha256,
        "0", "0", "0", "0", 1, stateSha256],
    );
    driver.exec(
      `INSERT INTO catalog.catalog_generation_events(
         catalog_generation,event_kind,app_instance_id,operation_id,write_epoch,at,
         target_generation_id,target_lineage_epoch,target_protection_revision,
         target_digest_schema,target_state_sha256
       ) VALUES (?,'app_seed',?,?,?, ?,?,?,?,?,?)`,
      [catalogGeneration, appInstanceId, operationId, before.writeEpoch, at,
        generationId, "0", "0", 1, stateSha256],
    );
    driver.exec(
      "UPDATE catalog.catalog_root SET catalog_generation=? WHERE singleton=1",
      [catalogGeneration],
    );
  });
  return { appInstanceId, catalogGeneration };
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
        .toEqual(["1", "2", unrelated.catalogGeneration]);
      expect(authority.catalogAuthority.generationEvents.at(-1)!.appInstanceId)
        .toBe(unrelated.appInstanceId);
      const imported = await importAuthorityArchive(archive);
      imported.store.close();
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
        schema: 1, stateSha256: merkle.stateSha256, leafCount: merkle.leafCount,
      });
      expect(authority.targetAuthority.revisions).toEqual([]);
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

      const imported = await importAuthorityArchive(archive);
      try {
        expect(imported.authority).toMatchObject({
          kind: "format5_authority_evidence",
          checksumAuthenticated: true,
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
          checksumAuthenticated: false,
          evidence: null,
        });
        expect(imported.store.query({ from: "projects" })).toHaveLength(3);
      } finally {
        imported.store.close();
      }
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
