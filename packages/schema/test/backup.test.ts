import { describe, expect, it } from "vitest";
import {
  BackupAuthenticationV1,
  BackupRecordV1,
  BackupResultV1,
  BackupRunV1,
  BackupSelectedTargetV1,
  BackupStageValidationV1,
  BackupTargetAdapterCertificationV1,
  BackupTargetV1,
  ManualBackupDownloadV1,
} from "../src/backup";
import { AuthenticatedFormat5RestoreGrantV1 } from "../src/restore";

const id = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;
const sha = (char: string): string => `sha256:${char.repeat(64)}`;

const authentication = {
  schema: 1 as const,
  kind: "cose_mac0_hmac_256_256" as const,
  authenticationVersion: 1 as const,
  keyId: "10".repeat(16),
  seriesId: "20".repeat(16),
  generation: "9",
};

const evidence = {
  appInstanceId: id("app", "a"),
  activeGenerationId: id("gen", "b"),
  lineageEpoch: "3",
  protectionRevision: "8",
  digestSchema: 1 as const,
  stateSha256: sha("c"),
};

const selectedTarget = {
  schema: 1 as const,
  authorityIncarnationId: id("auth", "d"),
  catalogGeneration: "21",
  writeEpoch: "5",
  selectedAppInstanceId: evidence.appInstanceId,
  selectedActiveGenerationId: evidence.activeGenerationId,
  target: evidence,
};

const backupTarget = {
  schema: 1 as const,
  targetId: id("tgt", "e"),
  appInstanceId: evidence.appInstanceId,
  adapter: "browser_directory" as const,
  adapterCertificationId: id("btc", "f"),
  authorizedAt: "2026-09-05T20:00:00.000Z",
};

const run = {
  schema: 1 as const,
  backupId: id("bkp", "g"),
  generationId: id("backupgen", "h"),
  target: backupTarget,
  expected: selectedTarget,
  fence: {
    authorityIncarnationId: selectedTarget.authorityIncarnationId,
    writeEpoch: selectedTarget.writeEpoch,
    leaseId: id("lease", "i"),
    releaseId: id("rel", "j"),
  },
  reason: "meaningful_write" as const,
  attempt: "fresh" as const,
  fileLabel: "Quarterly / Field Ops",
  createdAt: "2026-09-05T20:01:02.003Z",
  archive: {
    format: 5 as const,
    byteLength: 12,
    archiveSha256: sha("a"),
    authentication,
    shapeHead: 7,
    shapeCurrent: 6,
  },
};

const certification = {
  schema: 1 as const,
  certificationId: backupTarget.adapterCertificationId,
  binding: {
    implementationId: "clay.browser-directory",
    implementationVersion: "1.0.0",
    codeSha256: sha("1"),
    releaseId: id("rel", "m"),
    buildSha256: sha("2"),
    runtime: {
      distribution: "managed_web" as const,
      osFamily: "windows" as const,
      osVersion: "11.0.0",
      runtimeFamily: "chromium" as const,
      runtimeVersion: "149.0.7827.55",
      architecture: "x64" as const,
    },
    matrixId: "browser-backup-matrix-v1",
    matrixSha256: sha("3"),
    suiteId: "browser-backup-suite-v1",
    suiteSha256: sha("4"),
  },
  adapter: "browser_directory" as const,
  issuedAt: "2026-09-05T19:00:00.000Z",
  expiresAt: "2026-10-05T19:00:00.000Z",
  verdict: "pass" as const,
  restartProbe: {
    probeId: id("probe", "n"),
    firstProcessWriteSha256: sha("5"),
    fullProcessExitObserved: true as const,
    freshProcessReacquiredWithoutPicker: true as const,
    permissionRechecked: true as const,
    firstFileReadBackSha256: sha("5"),
    secondUniqueFileReadBackSha256: sha("6"),
    enumerationObservedBoth: true as const,
    ownedProbeCleanupVerified: true as const,
    evidenceSha256: sha("7"),
  },
};

const fileName = "clay-quarterly-field-ops-20260905T200102003Z-backupgen_hhhhhhhhhhhhhhhhhhhhhhhhhh.clay";
const record = {
  schema: 1 as const,
  backupId: run.backupId,
  generationId: run.generationId,
  targetId: backupTarget.targetId,
  evidence,
  publicationCatalogGeneration: "22",
  fileName,
  createdAt: run.createdAt,
  validatedAt: "2026-09-05T20:01:03.000Z",
  shapeHead: run.archive.shapeHead,
  shapeCurrent: run.archive.shapeCurrent,
  archiveFormat: 5 as const,
  byteLength: run.archive.byteLength,
  archiveSha256: run.archive.archiveSha256,
  authentication,
  adapterCertificationId: backupTarget.adapterCertificationId,
  state: "valid" as const,
  validationCode: "archive_valid" as const,
};

describe("Release B2 external-backup contracts", () => {
  it("requires an exact bounded passing restart certification artifact", () => {
    expect(BackupTargetAdapterCertificationV1.parse(certification)).toEqual(certification);
    expect(BackupTargetAdapterCertificationV1.safeParse({
      ...certification,
      verdict: "fail",
    }).success).toBe(false);
    expect(BackupTargetAdapterCertificationV1.safeParse({
      ...certification,
      binding: { ...certification.binding, implementationId: "x".repeat(65) },
    }).success).toBe(false);
    expect(BackupTargetAdapterCertificationV1.safeParse({
      ...certification,
      restartProbe: {
        ...certification.restartProbe,
        freshProcessReacquiredWithoutPicker: false,
      },
    }).success).toBe(false);
    expect(BackupTargetAdapterCertificationV1.safeParse({
      ...certification,
      expiresAt: certification.issuedAt,
    }).success).toBe(false);
    expect(BackupTargetAdapterCertificationV1.safeParse({
      ...certification,
      unknownEvidence: true,
    }).success).toBe(false);
  });

  it("binds a run to one strict selected catalog target, certified copy target, and write fence", () => {
    expect(BackupSelectedTargetV1.parse(selectedTarget)).toEqual(selectedTarget);
    expect(BackupTargetV1.parse(backupTarget)).toEqual(backupTarget);
    expect(BackupRunV1.parse(run)).toEqual(run);

    expect(BackupSelectedTargetV1.safeParse({
      ...selectedTarget,
      selectedActiveGenerationId: id("gen", "k"),
    }).success).toBe(false);
    expect(BackupSelectedTargetV1.safeParse({
      ...selectedTarget,
      selectedAppInstanceId: id("app", "k"),
    }).success).toBe(false);
    expect(BackupRunV1.safeParse({
      ...run,
      target: { ...run.target, appInstanceId: id("app", "z") },
    }).success).toBe(false);
    expect(BackupRunV1.safeParse({
      ...run,
      fence: { ...run.fence, writeEpoch: "6" },
    }).success).toBe(false);
    expect(BackupRunV1.safeParse({ ...run, callerPath: "../../outside" }).success).toBe(false);
  });

  it("bounds automatic snapshots and admits only authority-bearing format 5 semantics", () => {
    expect(BackupAuthenticationV1.parse(authentication)).toEqual(authentication);
    expect(BackupRunV1.safeParse({
      ...run,
      archive: { ...run.archive, format: 4 },
    }).success).toBe(false);
    expect(BackupRunV1.safeParse({
      ...run,
      archive: { ...run.archive, byteLength: 384 * 1024 * 1024 + 1 },
    }).success).toBe(false);
    expect(BackupRunV1.safeParse({
      ...run,
      archive: { ...run.archive, shapeCurrent: run.archive.shapeHead + 1 },
    }).success).toBe(false);
    expect(BackupRunV1.safeParse({
      ...run,
      archive: { ...run.archive, authentication: undefined },
    }).success).toBe(false);
    expect(BackupRunV1.safeParse({
      ...run,
      archive: { ...run.archive, authentication: { ...authentication, generation: "0" } },
    }).success).toBe(false);
    expect(BackupStageValidationV1.safeParse({
      schema: 1, status: "valid", evidence, authentication,
    }).success).toBe(true);
    expect(BackupStageValidationV1.safeParse({
      schema: 1, status: "valid", evidence,
    }).success).toBe(false);
    expect(BackupRunV1.safeParse({ ...run, fileLabel: "x".repeat(121) }).success).toBe(false);
  });

  it("accepts only bounded owned-file records with coherent closed validation state", () => {
    expect(BackupRecordV1.parse(record)).toEqual(record);
    expect(BackupRecordV1.safeParse({ ...record, path: `C:/private/${fileName}` }).success)
      .toBe(false);
    expect(BackupRecordV1.safeParse({ ...record, fileName: "../escape.clay" }).success)
      .toBe(false);
    expect(BackupRecordV1.safeParse({ ...record, archiveFormat: 4 }).success).toBe(false);
    expect(BackupRecordV1.safeParse({
      ...record,
      state: "valid",
      validationCode: "digest_mismatch",
    }).success).toBe(false);
    expect(BackupRecordV1.safeParse({
      ...record,
      validatedAt: "2026-09-05T20:01:01.000Z",
    }).success).toBe(false);
  });

  it("returns only closed outcomes and never transports exception or content detail", () => {
    const failed = {
      schema: 1 as const,
      status: "failed" as const,
      reasonCode: "permission_required" as const,
      historical: null,
    };
    expect(BackupResultV1.parse(failed)).toEqual(failed);
    expect(BackupResultV1.safeParse({
      ...failed, reasonCode: "operation_interrupted",
    }).success).toBe(true);
    expect(BackupResultV1.safeParse({ ...failed, detail: "secret row value" }).success)
      .toBe(false);
    expect(BackupResultV1.safeParse({ ...failed, reasonCode: "NotAllowedError" }).success)
      .toBe(false);
    expect(BackupResultV1.safeParse({
      schema: 1,
      status: "published",
      publication: "published",
      record,
      rotation: { requested: 0, deleted: 0, failed: 0 },
    }).success).toBe(true);
  });

  it("keeps manual download separate and explicitly unverified", () => {
    const manual = {
      schema: 1 as const,
      kind: "manual_download" as const,
      archiveFormat: 4 as const,
      fileName: "clay-2026-09-05.clay",
      byteLength: 12,
      startedAt: "2026-09-05T20:01:02.003Z",
      verification: "unverified" as const,
    };
    expect(ManualBackupDownloadV1.parse(manual)).toEqual(manual);
    expect(ManualBackupDownloadV1.safeParse({ ...manual, verification: "verified" }).success)
      .toBe(false);
    expect(BackupRecordV1.safeParse(manual).success).toBe(false);
    expect(BackupResultV1.safeParse({
      schema: 1,
      status: "published",
      publication: "published",
      record: manual,
      rotation: { requested: 0, deleted: 0, failed: 0 },
    }).success).toBe(false);
  });

  it("admits restore-as-new only with an authenticated format-5 grant for a distinct app", () => {
    const grant = {
      schema: 1 as const,
      kind: "authenticated_format5_restore_as_new" as const,
      validationId: id("restoreval", "v"),
      archiveFormat: 5 as const,
      cryptographicallyAuthenticated: true as const,
      authentication,
      freshness: "current" as const,
      archiveSha256: sha("8"),
      archiveTarget: evidence,
      preservedAppInstanceId: evidence.appInstanceId,
      destinationAppInstanceId: id("app", "z"),
      installMode: "new_app_only" as const,
      validatedAt: "2026-09-05T20:01:04.000Z",
    };
    expect(AuthenticatedFormat5RestoreGrantV1.parse(grant)).toEqual(grant);
    for (const invalid of [
      { ...grant, archiveFormat: 4 },
      { ...grant, cryptographicallyAuthenticated: false },
      { ...grant, authentication: { ...authentication, seriesId: "21".repeat(15) } },
      { ...grant, installMode: "replace_current" },
      { ...grant, destinationAppInstanceId: grant.preservedAppInstanceId },
      { ...grant, untrustedDetail: "looks valid" },
    ]) expect(AuthenticatedFormat5RestoreGrantV1.safeParse(invalid).success).toBe(false);
    expect(AuthenticatedFormat5RestoreGrantV1.safeParse({
      ...grant,
      checksumAuthenticated: true,
    }).success).toBe(false);
  });
});
