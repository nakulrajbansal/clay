import {
  AutomaticBackupFileName,
  BackupFailureReasonCodeV1,
  BackupGenerationId,
  BackupPublicationReceiptV1,
  BackupPublicationRequestV1,
  BackupResultV1,
  BackupRunV1,
  BackupSelectedTargetV1,
  BackupStageValidationV1,
  ValidatedBackupArtifactV1,
  type BackupFailureReasonCodeV1 as BackupFailureReason,
  type BackupAuthenticationV1 as BackupAuthentication,
  type BackupPublicationRequestV1 as BackupPublicationRequest,
  type BackupRecordV1 as BackupRecord,
  type BackupResultV1 as BackupResult,
  type BackupRunV1 as BackupRun,
  type BackupSelectedTargetV1 as BackupSelectedTarget,
  type BackupStageValidationV1 as BackupStageValidation,
  type ValidatedBackupArtifactV1 as ValidatedBackupArtifact,
} from "@clay/schema/standalone/backup";
import { CanonicalInstant, type TargetEvidenceV1 as TargetEvidence } from "@clay/schema/standalone/catalog";
import { sha256HexSync } from "./state-digest";

export interface ExternalBackupWriter {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/** Narrow, directory-scoped capability. No caller path or enumeration surface exists. */
export interface ExternalBackupDirectory {
  readonly targetId: string;
  createNew(fileName: string): Promise<ExternalBackupWriter>;
  readExact(fileName: string): Promise<Uint8Array>;
  removeExact(fileName: string): Promise<void>;
}

export interface ExternalBackupAuthority {
  readSelectedTarget(): Promise<unknown>;
  publish(request: BackupPublicationRequest): Promise<unknown>;
}

export type IsolatedArchiveStageValidator = (
  bytes: Uint8Array,
  expected: TargetEvidence,
) => Promise<unknown>;

export interface ExternalBackupDependencies {
  directory: ExternalBackupDirectory;
  authority: ExternalBackupAuthority;
  validateArchiveStage: IsolatedArchiveStageValidator;
  now(): string;
  /** Trusted-shell per-file authority/acknowledgement runner. Rotation hints alone never authorize unlink. */
  retainPublished?(receipt: import("@clay/schema/backup").BackupPublicationReceiptV1): Promise<{
    requested: number; deleted: number; failed: number;
  }>;
  /** Internal trusted path: the caller transferred sole ownership of this buffer. */
  archiveBytesOwnership?: "transferred";
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${sha256HexSync(bytes)}`;
}

function canReleaseTransferredBytes(bytes: Uint8Array): bytes is Uint8Array<ArrayBuffer> {
  if (!(bytes.buffer instanceof ArrayBuffer)
      || bytes.byteOffset !== 0
      || bytes.byteLength !== bytes.buffer.byteLength) return false;
  return typeof Reflect.get(bytes.buffer, "transfer") === "function";
}

function releaseTransferredBytes(bytes: Uint8Array<ArrayBuffer>): boolean {
  try {
    // Wipe secrets before surrendering the backing store, then shrink it to
    // zero. Filling alone leaves a 384 MiB allocation live while read-back is
    // allocated; ArrayBuffer transfer(0) detaches and releases that ownership.
    bytes.fill(0);
    const transfer = Reflect.get(bytes.buffer, "transfer");
    if (typeof transfer !== "function") return false;
    const released = Reflect.apply(transfer, bytes.buffer, [0]);
    return released instanceof ArrayBuffer
      && released.byteLength === 0
      && bytes.byteLength === 0;
  } catch {
    return false;
  }
}

function evidenceEquals(left: TargetEvidence, right: TargetEvidence): boolean {
  return left.appInstanceId === right.appInstanceId
    && left.activeGenerationId === right.activeGenerationId
    && left.lineageEpoch === right.lineageEpoch
    && left.protectionRevision === right.protectionRevision
    && left.digestSchema === right.digestSchema
    && left.stateSha256 === right.stateSha256;
}

function authenticationEquals(
  left: BackupAuthentication,
  right: BackupAuthentication,
): boolean {
  return left.schema === right.schema
    && left.kind === right.kind
    && left.authenticationVersion === right.authenticationVersion
    && left.keyId === right.keyId
    && left.seriesId === right.seriesId
    && left.generation === right.generation;
}

function selectionEquals(
  left: BackupSelectedTarget,
  right: BackupSelectedTarget,
): boolean {
  return left.authorityIncarnationId === right.authorityIncarnationId
    && left.catalogGeneration === right.catalogGeneration
    && left.writeEpoch === right.writeEpoch
    && left.selectedAppInstanceId === right.selectedAppInstanceId
    && left.selectedActiveGenerationId === right.selectedActiveGenerationId
    && evidenceEquals(left.target, right.target);
}

function driftReason(
  expected: BackupSelectedTarget,
  observed: BackupSelectedTarget | null,
): BackupFailureReason {
  if (!observed) return "backup_stale";
  if (observed.writeEpoch !== expected.writeEpoch) return "stale_write_epoch";
  if (observed.selectedAppInstanceId !== expected.selectedAppInstanceId
      || observed.selectedActiveGenerationId !== expected.selectedActiveGenerationId
      || observed.target.appInstanceId !== expected.target.appInstanceId
      || observed.target.activeGenerationId !== expected.target.activeGenerationId)
    return "generation_not_selected";
  return "backup_stale";
}

function closedIoReason(error: unknown): BackupFailureReason {
  if (error && (typeof error === "object" || typeof error === "function")) {
    const candidate = Reflect.get(error, "reasonCode");
    const parsed = BackupFailureReasonCodeV1.safeParse(candidate);
    if (parsed.success && [
      "adapter_uncertified",
      "unsupported_api",
      "target_unconfigured",
      "permission_required",
      "target_unreachable",
      "quota_exceeded",
      "destination_collision",
      "operation_interrupted",
    ].includes(parsed.data)) return parsed.data;
  }
  return "target_unreachable";
}

function failed(
  reasonCode: BackupFailureReason,
  historical: ValidatedBackupArtifact | null = null,
): BackupResult {
  return BackupResultV1.parse({ schema: 1, status: "failed", reasonCode, historical });
}

function sanitizeLabel(label: string): string {
  const normalized = label.normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const bounded = normalized.slice(0, 48).replace(/-+$/g, "");
  return bounded || "app";
}

/** Build one filename segment; paths and caller-selected filenames are impossible. */
export function buildAutomaticBackupFileName(
  fileLabelInput: string,
  generationIdInput: string,
  createdAtInput: string,
): string {
  if (typeof fileLabelInput !== "string" || fileLabelInput.length === 0
      || fileLabelInput.length > 120 || /[\u0000-\u001f\u007f]/.test(fileLabelInput))
    throw new Error("invalid backup file label");
  const generationId = BackupGenerationId.parse(generationIdInput);
  const createdAt = CanonicalInstant.parse(createdAtInput);
  const timestamp = createdAt.replace(/[-:.]/g, "");
  return AutomaticBackupFileName.parse(
    `clay-${sanitizeLabel(fileLabelInput)}-${timestamp}-${generationId}.clay`,
  );
}

async function readSelectedTarget(
  authority: ExternalBackupAuthority,
): Promise<BackupSelectedTarget | null> {
  try {
    const parsed = BackupSelectedTargetV1.safeParse(await authority.readSelectedTarget());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function artifactMatchesRecord(
  artifact: ValidatedBackupArtifact,
  record: BackupRecord,
  publication: "published" | "already_published",
): boolean {
  const validationTimeMatches = publication === "published"
    ? record.validatedAt === artifact.validatedAt
    : record.validatedAt >= record.createdAt && record.validatedAt <= artifact.validatedAt;
  return record.backupId === artifact.backupId
    && record.generationId === artifact.generationId
    && record.targetId === artifact.targetId
    && evidenceEquals(record.evidence, artifact.evidence)
    && record.fileName === artifact.fileName
    && record.createdAt === artifact.createdAt
    && validationTimeMatches
    && record.shapeHead === artifact.shapeHead
    && record.shapeCurrent === artifact.shapeCurrent
    && record.archiveFormat === artifact.archiveFormat
    && record.byteLength === artifact.byteLength
    && record.archiveSha256 === artifact.archiveSha256
    && authenticationEquals(record.authentication, artifact.authentication)
    && record.adapterCertificationId === artifact.adapterCertificationId
    && record.state === "valid"
    && record.validationCode === "archive_valid";
}

function validRotation(
  records: BackupRecord[],
  current: BackupRecord,
): boolean {
  const backupIds = new Set<string>();
  const generationIds = new Set<string>();
  const fileNames = new Set<string>();
  for (const record of records) {
    if (record.state !== "valid" || record.validationCode !== "archive_valid"
        || record.targetId !== current.targetId
        || record.adapterCertificationId !== current.adapterCertificationId
        || record.evidence.appInstanceId !== current.evidence.appInstanceId
        || record.backupId === current.backupId
        || record.generationId === current.generationId
        || record.fileName === current.fileName
        || backupIds.has(record.backupId)
        || generationIds.has(record.generationId)
        || fileNames.has(record.fileName)) return false;
    backupIds.add(record.backupId);
    generationIds.add(record.generationId);
    fileNames.add(record.fileName);
  }
  return true;
}

function publicationGenerationIsCoherent(
  run: BackupRun,
  publication: "published" | "already_published",
  record: BackupRecord,
): boolean {
  const actual = BigInt(record.publicationCatalogGeneration);
  const expected = BigInt(run.expected.catalogGeneration);
  return publication === "published" ? actual === expected + 1n : actual <= expected;
}

/**
 * Execute one worker-snapshotted automatic backup. Public callers are copied at
 * entry; the production worker transfer path can hand over sole ownership.
 * Bytes are never returned, logged, sent to authority, or used as a path.
 */
export async function runExternalBackup(
  runInput: unknown,
  archiveBytesInput: Uint8Array,
  dependencies: ExternalBackupDependencies,
): Promise<BackupResult> {
  if (!(archiveBytesInput instanceof Uint8Array)) return failed("invalid_run");
  const receivesTransferredOwnership = dependencies.archiveBytesOwnership === "transferred";
  if (receivesTransferredOwnership && !canReleaseTransferredBytes(archiveBytesInput))
    return failed("adapter_uncertified");
  // Snapshot before parsing caller metadata or crossing an await boundary.
  const archiveBytes = receivesTransferredOwnership
    ? archiveBytesInput : archiveBytesInput.slice();
  const runResult = BackupRunV1.safeParse(runInput);
  if (!runResult.success) return failed("invalid_run");
  const run = runResult.data;
  if (archiveBytes.byteLength !== run.archive.byteLength
      || sha256(archiveBytes) !== run.archive.archiveSha256)
    return failed("snapshot_mismatch");
  if (dependencies.directory.targetId !== run.target.targetId)
    return failed("target_unconfigured");

  const initialSelection = await readSelectedTarget(dependencies.authority);
  if (!initialSelection || !selectionEquals(initialSelection, run.expected))
    return failed(driftReason(run.expected, initialSelection));

  let fileName: string;
  try {
    fileName = buildAutomaticBackupFileName(run.fileLabel, run.generationId, run.createdAt);
  } catch {
    return failed("invalid_run");
  }

  if (run.attempt === "fresh" || run.attempt === "write_reconcile") {
    let writer: ExternalBackupWriter | null = null;
    try {
      writer = await dependencies.directory.createNew(fileName);
    } catch (error) {
      // Only an immutable recovery candidate can reconcile a collision. Never
      // reopen for writing: the existing bytes still require exact readback,
      // digest, authentication, source validation and fenced publication below.
      if (run.attempt !== "write_reconcile" || closedIoReason(error) !== "destination_collision")
        return failed(closedIoReason(error));
    }
    if (writer) {
      let closeAttempted = false;
      try {
        await writer.write(archiveBytes);
        closeAttempted = true;
        await writer.close();
      } catch (error) {
        if (!closeAttempted) {
          try {
            closeAttempted = true;
            await writer.close();
          } catch { /* best-effort release; the first closed reason wins */ }
        }
        return failed(closedIoReason(error));
      }
    }
  }

  // The external writer has resolved, so no further write may retain this
  // buffer. Detach and release the worker snapshot before allocating the
  // directory read-back; zero-filling without detachment would leave two
  // archive-sized ArrayBuffers live in the presentation process.
  if (!canReleaseTransferredBytes(archiveBytes)
      || !releaseTransferredBytes(archiveBytes))
    return failed("adapter_uncertified");

  let finalBytes: Uint8Array;
  try {
    finalBytes = await dependencies.directory.readExact(fileName);
  } catch (error) {
    return failed(closedIoReason(error));
  }
  if (finalBytes.byteLength !== run.archive.byteLength) return failed("short_write");
  if (sha256(finalBytes) !== run.archive.archiveSha256) return failed("digest_mismatch");

  let stage: BackupStageValidation;
  try {
    const parsed = BackupStageValidationV1.safeParse(
      await dependencies.validateArchiveStage(finalBytes, structuredClone(run.expected.target)),
    );
    if (!parsed.success) return failed("backup_invalid");
    stage = parsed.data;
  } catch {
    return failed("backup_invalid");
  }
  if (stage.status !== "valid"
      || !evidenceEquals(stage.evidence, run.expected.target)
      || !authenticationEquals(stage.authentication, run.archive.authentication))
    return failed("backup_invalid");

  const artifactResult = ValidatedBackupArtifactV1.safeParse({
    schema: 1,
    backupId: run.backupId,
    generationId: run.generationId,
    targetId: run.target.targetId,
    evidence: run.expected.target,
    fileName,
    createdAt: run.createdAt,
    validatedAt: dependencies.now(),
    shapeHead: run.archive.shapeHead,
    shapeCurrent: run.archive.shapeCurrent,
    archiveFormat: 5,
    byteLength: run.archive.byteLength,
    archiveSha256: run.archive.archiveSha256,
    authentication: run.archive.authentication,
    adapterCertificationId: run.target.adapterCertificationId,
  });
  if (!artifactResult.success) return failed("backup_invalid");
  const artifact = artifactResult.data;

  // No filesystem or stage work is allowed between this reread and publication.
  const finalSelection = await readSelectedTarget(dependencies.authority);
  if (!finalSelection || !selectionEquals(finalSelection, run.expected))
    return failed(driftReason(run.expected, finalSelection), artifact);

  const publicationRequest = BackupPublicationRequestV1.parse({
    schema: 1,
    expected: run.expected,
    fence: run.fence,
    artifact,
  });
  let receiptResult;
  try {
    receiptResult = BackupPublicationReceiptV1.safeParse(
      await dependencies.authority.publish(publicationRequest),
    );
  } catch {
    return failed("publication_failed", artifact);
  }
  if (!receiptResult.success
      || !artifactMatchesRecord(
        artifact, receiptResult.data.record, receiptResult.data.publication,
      )
      || !publicationGenerationIsCoherent(
        run, receiptResult.data.publication, receiptResult.data.record,
      )
      || !validRotation(receiptResult.data.rotate, receiptResult.data.record))
    return failed("publication_failed", artifact);

  // The prior fire-and-forget loop could unlink without a durable receipt, then
  // starve older work forever on reload. Only the fenced per-file runner removes.
  const rotation = dependencies.retainPublished
    ? await dependencies.retainPublished(receiptResult.data)
    : { requested: receiptResult.data.rotate.length, deleted: 0, failed: receiptResult.data.rotate.length };

  return BackupResultV1.parse({
    schema: 1,
    status: "published",
    publication: receiptResult.data.publication,
    record: receiptResult.data.record,
    rotation,
  });
}
