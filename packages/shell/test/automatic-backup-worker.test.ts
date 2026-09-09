import { describe, expect, it } from "vitest";
import {
  BackupPublicationReceiptV1,
  BackupPublicationRequestV1,
  buildAutomaticBackupFileName,
  type BackupPublicationRequest,
  type BackupRecord,
  type BackupTrustRecordStore,
} from "@clay/kernel/backup";
import {
  CLAY_ARCHIVE_CONTENT_TYPE,
  sealAuthenticatedArchiveV5,
  verifyAuthenticatedArchiveV5,
} from "../../kernel/src/archive-authentication";
import { BackupTrustRuntime } from "../src/worker/backup-trust-runtime";
import { AutomaticBackupWorkerCoordinator } from "../src/worker/automatic-backup";

const id = (prefix: string, character: string): string =>
  `${prefix}_${character.repeat(26)}`;

class MemoryTrustStore implements BackupTrustRecordStore {
  readonly rows = new Map<string, unknown>();
  readonly candidates = new Map<string, unknown>();
  active: { revision: string; seriesId: string } | null = null;
  async load(key: string): Promise<unknown | null> {
    return this.rows.has(key) ? structuredClone(this.rows.get(key)) : null;
  }
  async compareAndSet(key: string, expected: string | null, next: unknown): Promise<boolean> {
    const current = this.rows.get(key) as { revision?: string } | undefined;
    if ((current?.revision ?? null) !== expected) return false;
    this.rows.set(key, structuredClone(next));
    return true;
  }
  async loadActiveSeries(): Promise<{ revision: string; seriesId: string } | null> {
    return this.active ? { ...this.active } : null;
  }
  async compareAndSetActiveSeries(expected: string | null, seriesId: string): Promise<boolean> {
    if ((this.active?.revision ?? null) !== expected) return false;
    this.active = {
      revision: expected === null ? "0" : String(BigInt(expected) + 1n),
      seriesId,
    };
    return true;
  }
  async loadAutomaticBackupCandidate(seriesId: string): Promise<unknown | null> {
    return this.candidates.has(seriesId)
      ? structuredClone(this.candidates.get(seriesId)) : null;
  }
  async compareAndSetAutomaticBackupCandidate(
    seriesId: string, expected: string | null, next: unknown,
  ): Promise<boolean> {
    const current = this.candidates.get(seriesId) as { revision?: string } | undefined;
    if ((current?.revision ?? null) !== expected) return false;
    this.candidates.set(seriesId, structuredClone(next));
    return true;
  }
  async removeAutomaticBackupCandidate(seriesId: string, expected: string): Promise<boolean> {
    const current = this.candidates.get(seriesId) as { revision?: string } | undefined;
    if (current?.revision !== expected) return false;
    return this.candidates.delete(seriesId);
  }
}

const targetEvidence = {
  appInstanceId: id("app", "a"),
  activeGenerationId: id("gen", "b"),
  lineageEpoch: "0",
  protectionRevision: "1",
  digestSchema: 1 as const,
  stateSha256: `sha256:${"c".repeat(64)}`,
};
const selection = {
  selected: {
    schema: 1 as const,
    authorityIncarnationId: id("auth", "d"),
    catalogGeneration: "10",
    writeEpoch: "2",
    selectedAppInstanceId: targetEvidence.appInstanceId,
    selectedActiveGenerationId: targetEvidence.activeGenerationId,
    target: targetEvidence,
  },
  fence: {
    authorityIncarnationId: id("auth", "d"),
    writeEpoch: "2",
    leaseId: id("lease", "e"),
    releaseId: id("rel", "f"),
  },
};

describe("automatic backup worker coordinator", () => {
  it("reserves trust, exports authenticated bytes, stages read-back, publishes, and commits freshness", async () => {
    const trust = new BackupTrustRuntime(new MemoryTrustStore(), {
      randomFill: bytes => bytes.forEach((_, index) => { bytes[index] = index + 1; }),
      createEnrollmentId: () => id("enroll", "g"),
    });
    const enrollment = trust.beginEnrollment();
    await trust.confirmEnrollment(enrollment.enrollmentId, enrollment.bytes.slice());

    const records: BackupRecord[] = [];
    const authority = {
      backupSelection: async () => structuredClone(selection),
      backupMetadata: () => ({ fileLabel: "Field Service", shapeHead: 7, shapeCurrent: 6 }),
      exportAuthenticatedArchive: async (material: {
        backupTrustKey: Uint8Array; keyId: Uint8Array; seriesId: Uint8Array; generation: bigint;
      }) => {
        const bytes = sealAuthenticatedArchiveV5(
          new Uint8Array([1, 2, 3]), material.backupTrustKey, {
            authenticationVersion: 1,
            archiveFormat: 5,
            contentType: CLAY_ARCHIVE_CONTENT_TYPE,
            keyId: material.keyId,
            seriesId: material.seriesId,
            generation: material.generation,
          },
        );
        const hex = (value: Uint8Array): string => [...value]
          .map(byte => byte.toString(16).padStart(2, "0")).join("");
        return {
          format: 5 as const,
          bytes,
          filename: "field-service.clay",
          target: targetEvidence,
          catalogGeneration: "10",
          authentication: {
            schema: 1 as const,
            kind: "cose_mac0_hmac_256_256" as const,
            authenticationVersion: 1 as const,
            keyId: hex(material.keyId),
            seriesId: hex(material.seriesId),
            generation: String(material.generation),
          },
        };
      },
      validateAuthenticatedArchiveStage: async (
        bytes: Uint8Array,
        expected: typeof targetEvidence,
        key: Uint8Array,
      ) => {
        const verified = verifyAuthenticatedArchiveV5(bytes, () => key);
        expect(verified.payload).toEqual(new Uint8Array([1, 2, 3]));
        return {
          schema: 1 as const,
          status: "valid" as const,
          evidence: expected,
          authentication: {
            schema: 1 as const,
            kind: "cose_mac0_hmac_256_256" as const,
            authenticationVersion: 1 as const,
            keyId: [...verified.header.keyId].map(byte => byte.toString(16).padStart(2, "0")).join(""),
            seriesId: [...verified.header.seriesId].map(byte => byte.toString(16).padStart(2, "0")).join(""),
            generation: String(verified.header.generation),
          },
        };
      },
      publishBackup: async (request: BackupPublicationRequest) => {
        const record = {
          ...request.artifact,
          publicationCatalogGeneration: "11",
          state: "valid" as const,
          validationCode: "archive_valid" as const,
        };
        records.push(record);
        return BackupPublicationReceiptV1.parse({
          schema: 1,
          publication: "published",
          record,
          rotate: [],
        });
      },
      backupRecords: async () => records.map(record => structuredClone(record)),
    };
    const coordinator = new AutomaticBackupWorkerCoordinator(authority, trust, {
      now: () => "2026-09-06T12:00:01.000Z",
      createBackupId: () => id("bkp", "h"),
      createGenerationId: () => id("backupgen", "i"),
    });
    const target = {
      schema: 1 as const,
      targetId: id("tgt", "j"),
      appInstanceId: targetEvidence.appInstanceId,
      adapter: "browser_directory" as const,
      adapterCertificationId: id("btc", "k"),
      authorizedAt: "2026-09-06T12:00:00.000Z",
    };

    const prepared = await coordinator.prepare(target, "backup_now");
    expect(prepared.run).toMatchObject({
      backupId: id("bkp", "h"),
      generationId: id("backupgen", "i"),
      expected: selection.selected,
      archive: { format: 5, authentication: { generation: "1" } },
    });
    const stage = await coordinator.validateStage(
      prepared.bytes.slice(), prepared.run.expected.target,
    );
    expect(stage).toMatchObject({ status: "valid", evidence: targetEvidence });
    const request = BackupPublicationRequestV1.parse({
      schema: 1,
      expected: prepared.run.expected,
      fence: prepared.run.fence,
      artifact: {
        schema: 1,
        backupId: prepared.run.backupId,
        generationId: prepared.run.generationId,
        targetId: prepared.run.target.targetId,
        evidence: prepared.run.expected.target,
        fileName: buildAutomaticBackupFileName(
          prepared.run.fileLabel, prepared.run.generationId, prepared.run.createdAt,
        ),
        createdAt: prepared.run.createdAt,
        validatedAt: "2026-09-06T12:00:02.000Z",
        shapeHead: prepared.run.archive.shapeHead,
        shapeCurrent: prepared.run.archive.shapeCurrent,
        archiveFormat: 5,
        byteLength: prepared.run.archive.byteLength,
        archiveSha256: prepared.run.archive.archiveSha256,
        authentication: prepared.run.archive.authentication,
        adapterCertificationId: prepared.run.target.adapterCertificationId,
      },
    });
    await expect(coordinator.publish(request)).resolves.toMatchObject({
      publication: "published",
      record: { backupId: prepared.run.backupId },
    });
    await expect(trust.status()).resolves.toMatchObject({
      status: "ready",
      freshness: "current",
      pending: null,
      committed: { backupId: prepared.run.backupId, generation: "1" },
    });
    await expect(coordinator.records()).resolves.toHaveLength(1);
  });

  it("exports a manual authenticated .clay file that round-trips through exact verification", async () => {
    const trustStore = new MemoryTrustStore();
    const trust = new BackupTrustRuntime(trustStore, {
      randomFill: bytes => bytes.forEach((_, index) => { bytes[index] = index + 1; }),
      createEnrollmentId: () => id("enroll", "x"),
    });
    const enrollment = trust.beginEnrollment();
    await trust.confirmEnrollment(enrollment.enrollmentId, enrollment.bytes.slice());
    const authority = {
      backupSelection: async () => structuredClone(selection),
      backupMetadata: () => ({ fileLabel: "Field Service", shapeHead: 7, shapeCurrent: 6 }),
      exportAuthenticatedArchive: async (material: {
        backupTrustKey: Uint8Array; keyId: Uint8Array; seriesId: Uint8Array; generation: bigint;
      }) => {
        const bytes = sealAuthenticatedArchiveV5(
          new Uint8Array([7, 8, 9]), material.backupTrustKey, {
            authenticationVersion: 1,
            archiveFormat: 5,
            contentType: CLAY_ARCHIVE_CONTENT_TYPE,
            keyId: material.keyId,
            seriesId: material.seriesId,
            generation: material.generation,
          },
        );
        const hex = (value: Uint8Array): string => [...value]
          .map(byte => byte.toString(16).padStart(2, "0")).join("");
        return {
          format: 5 as const,
          bytes,
          filename: "field-service.clay",
          target: targetEvidence,
          catalogGeneration: selection.selected.catalogGeneration,
          authentication: {
            schema: 1 as const,
            kind: "cose_mac0_hmac_256_256" as const,
            authenticationVersion: 1 as const,
            keyId: hex(material.keyId),
            seriesId: hex(material.seriesId),
            generation: material.generation.toString(),
          },
        };
      },
      validateAuthenticatedArchiveStage: async (
        bytes: Uint8Array,
        expected: typeof targetEvidence,
        key: Uint8Array,
      ) => {
        const verified = verifyAuthenticatedArchiveV5(bytes, () => key);
        const hex = (value: Uint8Array): string => [...value]
          .map(byte => byte.toString(16).padStart(2, "0")).join("");
        return {
          schema: 1 as const,
          status: "valid" as const,
          evidence: expected,
          authentication: {
            schema: 1 as const,
            kind: "cose_mac0_hmac_256_256" as const,
            authenticationVersion: 1 as const,
            keyId: hex(verified.header.keyId),
            seriesId: hex(verified.header.seriesId),
            generation: verified.header.generation.toString(),
          },
        };
      },
      publishBackup: async () => {
        throw new Error("manual export must not publish a folder record");
      },
      backupRecords: async () => [],
    };
    const coordinator = new AutomaticBackupWorkerCoordinator(authority, trust, {
      createBackupId: () => id("bkp", "y"),
    });
    const exported = await coordinator.prepareManualDownload();
    expect(exported.filename).toBe("field-service.clay");
    expect(trustStore.candidates.size).toBe(0);
    const status = await trust.status();
    expect(status).toMatchObject({ status: "ready", pending: null, freshness: "current" });
    if (status.status !== "ready") throw new Error("trust was not ready");
    const key = await trust.keyForSeries(status.seriesId);
    expect(key).not.toBeNull();
    try {
      expect(verifyAuthenticatedArchiveV5(exported.bytes, () => key!).payload)
        .toEqual(new Uint8Array([7, 8, 9]));
    } finally {
      key?.fill(0);
    }
  });

  it("reuses the exact durable candidate after restart instead of resealing a pending generation", async () => {
    const store = new MemoryTrustStore();
    const trust = new BackupTrustRuntime(store, {
      randomFill: bytes => bytes.forEach((_, index) => { bytes[index] = index + 1; }),
      createEnrollmentId: () => id("enroll", "q"),
    });
    const enrollment = trust.beginEnrollment();
    await trust.confirmEnrollment(enrollment.enrollmentId, enrollment.bytes.slice());
    let exports = 0;
    const authority = {
      backupSelection: async () => structuredClone(selection),
      backupMetadata: () => ({ fileLabel: "Field Service", shapeHead: 7, shapeCurrent: 6 }),
      exportAuthenticatedArchive: async (material: {
        backupTrustKey: Uint8Array; keyId: Uint8Array; seriesId: Uint8Array; generation: bigint;
      }) => {
        exports++;
        const bytes = sealAuthenticatedArchiveV5(
          new Uint8Array([exports, 2, 3]), material.backupTrustKey, {
            authenticationVersion: 1,
            archiveFormat: 5,
            contentType: CLAY_ARCHIVE_CONTENT_TYPE,
            keyId: material.keyId,
            seriesId: material.seriesId,
            generation: material.generation,
          },
        );
        const hex = (value: Uint8Array): string => [...value]
          .map(byte => byte.toString(16).padStart(2, "0")).join("");
        return {
          format: 5 as const,
          bytes,
          filename: "field-service.clay",
          target: targetEvidence,
          catalogGeneration: selection.selected.catalogGeneration,
          authentication: {
            schema: 1 as const,
            kind: "cose_mac0_hmac_256_256" as const,
            authenticationVersion: 1 as const,
            keyId: hex(material.keyId),
            seriesId: hex(material.seriesId),
            generation: material.generation.toString(),
          },
        };
      },
      validateAuthenticatedArchiveStage: async () => ({
        schema: 1 as const, status: "invalid" as const, evidence: null,
      }),
      publishBackup: async () => { throw new Error("not reached"); },
      backupRecords: async () => [],
    };
    const target = {
      schema: 1 as const,
      targetId: id("tgt", "r"),
      appInstanceId: targetEvidence.appInstanceId,
      adapter: "browser_directory" as const,
      adapterCertificationId: id("btc", "s"),
      authorizedAt: "2026-09-06T12:00:00.000Z",
    };
    const firstCoordinator = new AutomaticBackupWorkerCoordinator(authority, trust, {
      now: () => "2026-09-06T12:00:01.000Z",
      createBackupId: () => id("bkp", "t"),
      createGenerationId: () => id("backupgen", "u"),
    });
    const first = await firstCoordinator.prepare(target, "meaningful_write");

    const restarted = new AutomaticBackupWorkerCoordinator(authority, trust, {
      now: () => "2026-09-06T13:00:00.000Z",
      createBackupId: () => id("bkp", "v"),
      createGenerationId: () => id("backupgen", "w"),
    });
    const retry = await restarted.prepare(target, "retry");
    expect(exports).toBe(1);
    expect(retry.bytes).toEqual(first.bytes);
    expect(retry.run).toEqual(first.run);
    expect(retry.run.backupId).toBe(id("bkp", "t"));
    expect(retry.run.generationId).toBe(id("backupgen", "u"));
  });
});
