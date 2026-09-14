import {
  BackupPublicationRequestV1,
  BackupRunV1,
  BackupStageValidationV1,
  BackupTargetV1,
} from "@clay/schema/standalone/backup";
import { buildAutomaticBackupFileName } from "@clay/kernel/external-backup";
import { inspectAuthenticatedArchiveV5Header } from "@clay/kernel/archive-authentication";
import {
  type BackupPublicationReceipt,
  type BackupPublicationRequest,
  type BackupRecord,
  type BackupRun,
  type BackupStageValidation,
  type BackupTarget,
} from "@clay/kernel/backup";
import type {
  ProductionAuthenticatedArchiveExport,
  ProductionBackupSelection,
} from "@clay/kernel/worker-authority";
import { ClayError } from "@clay/kernel/errors";
import type { BackupTrustRuntime } from "./backup-trust-runtime";
import { withBackupTrustLock } from "./backup-operation-lock";
import { BackupResultV1 } from "@clay/schema/standalone/backup";

type TargetEvidence = ProductionBackupSelection["selected"]["target"];

const BACKUP_ID = /^bkp_[a-z2-7]{26}$/;
const BACKUP_GENERATION_ID = /^backupgen_[a-z2-7]{26}$/;
const MAX_STAGED_ENVELOPES = 4;
const UINT64 = /^(?:0|[1-9][0-9]{0,19})$/;

type ArchiveSealMaterial = {
  backupTrustKey: Uint8Array;
  keyId: Uint8Array;
  seriesId: Uint8Array;
  generation: bigint;
};

export interface AutomaticBackupWorkerAuthority {
  backupSelection(expected?: ProductionBackupSelection["selected"]): Promise<ProductionBackupSelection>;
  backupMetadata(): { fileLabel: string; shapeHead: number; shapeCurrent: number };
  exportAuthenticatedArchive(material: ArchiveSealMaterial):
    Promise<ProductionAuthenticatedArchiveExport>;
  validateAuthenticatedArchiveStage(
    bytes: Uint8Array,
    expected: TargetEvidence,
    backupTrustKey: Uint8Array,
  ): Promise<BackupStageValidation>;
  publishBackup(request: BackupPublicationRequest): Promise<BackupPublicationReceipt>;
  backupRecords(): Promise<BackupRecord[]>;
}

export type PreparedAutomaticBackup = Readonly<{
  run: BackupRun;
  bytes: Uint8Array;
}>;

export type PreparedManualBackup = Readonly<{
  format: 5;
  bytes: Uint8Array;
  filename: string;
  target: TargetEvidence;
  catalogGeneration: string;
  authentication: BackupRun["archive"]["authentication"];
}>;

type StoredAutomaticBackupCandidate = Readonly<{
  schema: 1;
  revision: string;
  seriesId: string;
  backupId: string;
  generation: string;
  phase: "prepared" | "staged";
  run: BackupRun;
  bytes: Uint8Array;
}>;

function unavailable(message: string): ClayError {
  return new ClayError("E_CATALOG_UNAVAILABLE", message);
}

function bytesToHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

function sameTarget(left: TargetEvidence, right: TargetEvidence): boolean {
  return left.appInstanceId === right.appInstanceId
    && left.activeGenerationId === right.activeGenerationId
    && left.lineageEpoch === right.lineageEpoch
    && left.protectionRevision === right.protectionRevision
    && left.digestSchema === right.digestSchema
    && left.stateSha256 === right.stateSha256;
}

function authenticationMatchesHeader(
  authentication: BackupRun["archive"]["authentication"],
  header: ReturnType<typeof inspectAuthenticatedArchiveV5Header>,
): boolean {
  return authentication.authenticationVersion === header.authenticationVersion
    && authentication.keyId === bytesToHex(header.keyId)
    && authentication.seriesId === bytesToHex(header.seriesId)
    && authentication.generation === header.generation.toString();
}

function parseStoredCandidate(
  input: unknown,
  seriesId: string,
  pending: Readonly<{ backupId: string; generation: string }>,
): StoredAutomaticBackupCandidate {
  if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype
      || Object.keys(input).sort().join("\u0000")
        !== "backupId\u0000bytes\u0000generation\u0000phase\u0000revision\u0000run\u0000schema\u0000seriesId")
    throw unavailable("Durable automatic-backup candidate is malformed");
  const value = input as Record<string, unknown>;
  const run = BackupRunV1.safeParse(value.run);
  if (value.schema !== 1 || typeof value.revision !== "string" || !UINT64.test(value.revision)
      || value.seriesId !== seriesId || value.backupId !== pending.backupId
      || value.generation !== pending.generation
      || (value.phase !== "prepared" && value.phase !== "staged")
      || !run.success || run.data.backupId !== pending.backupId
      || run.data.archive.authentication.seriesId !== seriesId
      || run.data.archive.authentication.generation !== pending.generation
      || !(value.bytes instanceof Uint8Array)
      || Object.getPrototypeOf(value.bytes) !== Uint8Array.prototype
      || value.bytes.byteLength !== run.data.archive.byteLength)
    throw unavailable("Durable automatic-backup candidate does not match its trust reservation");
  return Object.freeze({
    schema: 1,
    revision: value.revision,
    seriesId,
    backupId: pending.backupId,
    generation: pending.generation,
    phase: value.phase,
    run: run.data,
    bytes: value.bytes,
  });
}

function nextCandidateRevision(revision: string): string {
  const current = BigInt(revision);
  if (current >= (1n << 64n) - 1n)
    throw unavailable("Durable automatic-backup candidate revision is exhausted");
  return String(current + 1n);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle)
    throw unavailable("Web Crypto digest is unavailable for automatic backup");
  if (!(bytes.buffer instanceof ArrayBuffer))
    throw unavailable("Automatic-backup bytes are not owned by an ArrayBuffer");
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256", bytes as Uint8Array<ArrayBuffer>,
  );
  return `sha256:${bytesToHex(new Uint8Array(digest))}`;
}

function randomId(prefix: "bkp" | "backupgen", pattern: RegExp): string {
  if (!globalThis.crypto?.getRandomValues)
    throw unavailable("Secure backup identity generation is unavailable");
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const source = globalThis.crypto.getRandomValues(new Uint8Array(17));
  let bits = 0;
  let value = 0;
  let encoded = "";
  for (const byte of source) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && encoded.length < 26) {
      bits -= 5;
      encoded += alphabet[(value >>> bits) & 31];
      value &= (1 << bits) - 1;
    }
  }
  const result = `${prefix}_${encoded}`;
  if (!pattern.test(result)) throw unavailable("Secure backup identity generation failed");
  return result;
}

function matchesCandidate(record: BackupRecord, stored: StoredAutomaticBackupCandidate): boolean {
  const run = stored.run;
  return record.state === "valid" && record.backupId === run.backupId && record.generationId === run.generationId
    && record.targetId === run.target.targetId && sameTarget(record.evidence, run.expected.target)
    && record.fileName === buildAutomaticBackupFileName(run.fileLabel, run.generationId, run.createdAt)
    && record.createdAt === run.createdAt && record.shapeHead === run.archive.shapeHead && record.shapeCurrent === run.archive.shapeCurrent
    && record.byteLength === run.archive.byteLength && record.archiveSha256 === run.archive.archiveSha256
    && JSON.stringify(record.authentication) === JSON.stringify(run.archive.authentication)
    && record.adapterCertificationId === run.target.adapterCertificationId;
}

export class AutomaticBackupWorkerCoordinator {
  readonly #now: () => string;
  readonly #createBackupId: () => string;
  readonly #createGenerationId: () => string;
  readonly #staged = new Map<string, Uint8Array>();

  constructor(
    private readonly authority: AutomaticBackupWorkerAuthority,
    private readonly trust: BackupTrustRuntime,
    options: {
      now?: () => string;
      createBackupId?: () => string;
      createGenerationId?: () => string;
    } = {},
  ) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createBackupId = options.createBackupId
      ?? (() => randomId("bkp", BACKUP_ID));
    this.#createGenerationId = options.createGenerationId
      ?? (() => randomId("backupgen", BACKUP_GENERATION_ID));
  }

  async prepare(
    targetInput: BackupTarget,
    reason: BackupRun["reason"],
  ): Promise<PreparedAutomaticBackup> {
    return withBackupTrustLock(() => this.#prepare(targetInput, reason));
  }

  async #prepare(targetInput: BackupTarget, reason: BackupRun["reason"]): Promise<PreparedAutomaticBackup> {
    const target = BackupTargetV1.parse(targetInput);
    const trustStatus = await this.trust.status();
    if (trustStatus.status !== "ready")
      throw unavailable("Automatic backup requires completed Recovery Kit enrollment");
    const seriesId = trustStatus.seriesId;
    const storedInput = await this.trust.loadAutomaticBackupCandidate(seriesId);
    if (!trustStatus.pending && storedInput !== null) {
      const stored = parseStoredCandidate(storedInput, seriesId, {
        backupId: Reflect.get(Object(storedInput), "backupId"), generation: Reflect.get(Object(storedInput), "generation"),
      });
      if (stored.backupId !== trustStatus.committed?.backupId) {
        if (BigInt(stored.generation) >= BigInt(trustStatus.nextGeneration)
            || (await this.authority.backupRecords()).some(record => record.backupId === stored.backupId))
          throw unavailable("Orphaned backup candidate has an uncertain publication; it was retained");
        if (!(await this.trust.removeAutomaticBackupCandidate(seriesId, stored.revision)))
          throw unavailable("Retired candidate cleanup changed concurrently; retry");
        stored.bytes.fill(0);
        throw unavailable("Retired candidate cleanup completed. Earlier files kept; retry.");
      }
    }
    const recovering = trustStatus.pending ?? (storedInput !== null ? trustStatus.committed : null);
    if (recovering) {
      if (storedInput === null) {
        await this.trust.abandon(
          seriesId, recovering.backupId, BigInt(recovering.generation),
        );
        throw unavailable(
          "Pending Backup Trust generation had no durable candidate and was permanently abandoned",
        );
      }
      const stored = parseStoredCandidate(storedInput, seriesId, recovering);
      if (await sha256(stored.bytes) !== stored.run.archive.archiveSha256)
        throw unavailable("Durable automatic-backup candidate digest is invalid");
      const records = await this.authority.backupRecords(); // all apps for trust reconciliation
      const published = records.find(record => record.backupId === stored.backupId);
      if (published && !matchesCandidate(published, stored)) throw unavailable("Published backup disagrees with its durable candidate");
      if (!trustStatus.pending && (!published || trustStatus.committed?.envelopeSha256 !== stored.run.archive.archiveSha256))
        throw unavailable("Committed backup candidate lacks its exact catalog publication");
      const current = await this.authority.backupSelection();
      const sameFolder = JSON.stringify(target) === JSON.stringify(stored.run.target);
      const sameSource = sameTarget(current.selected.target, stored.run.expected.target)
        && current.selected.authorityIncarnationId === stored.run.expected.authorityIncarnationId;
      if (!sameFolder || !sameSource) {
        // Never abandon an outcome-ambiguous publication: reconcile its exact
        // catalog record first, under the same lock as every publisher.
        if (published) await this.trust.commit(seriesId, stored.backupId, BigInt(stored.generation), stored.bytes);
        else await this.trust.abandon(seriesId, stored.backupId, BigInt(stored.generation));
        if (!(await this.trust.removeAutomaticBackupCandidate(seriesId, stored.revision)))
          throw unavailable("Previous backup candidate changed during recovery; retry");
        this.#staged.get(stored.run.archive.archiveSha256)?.fill(0);
        this.#staged.delete(stored.run.archive.archiveSha256); stored.bytes.fill(0);
        throw unavailable(published ? "Previous published backup reconciled. Retry for the selected app and folder."
          : "Previous backup candidate is stale for this app or folder. Earlier files kept; retry.");
      }
      let refreshed = current;
      if (!published) {
        try { refreshed = await this.authority.backupSelection(stored.run.expected); }
        catch (error) {
          // Source-preserving non-lease changes require a fresh snapshot. Only
          // a specific stale-selection rejection permits retiring this candidate.
          if (!(error instanceof ClayError) || error.code !== "E_GENERATION_NOT_SELECTED") throw error;
          await this.trust.abandon(seriesId, stored.backupId, BigInt(stored.generation));
          if (!(await this.trust.removeAutomaticBackupCandidate(seriesId, stored.revision))) throw unavailable("Stale candidate cleanup needs retry");
          stored.bytes.fill(0); throw unavailable("Backup catalog changed; stale candidate retired. Retry a fresh snapshot.");
        }
      }
      const attempt = published || stored.phase === "staged" ? "publication_reconcile" : "write_reconcile";
      if (JSON.stringify(refreshed.selected) !== JSON.stringify(stored.run.expected)
          || JSON.stringify(refreshed.fence) !== JSON.stringify(stored.run.fence) || attempt !== stored.run.attempt) {
        const next = { ...stored, revision: nextCandidateRevision(stored.revision), run: BackupRunV1.parse({
          ...stored.run, expected: refreshed.selected, fence: refreshed.fence, attempt,
        }) };
        if (!(await this.trust.compareAndSetAutomaticBackupCandidate(seriesId, stored.revision, next)))
          throw unavailable("Backup lease refresh changed concurrently; retry");
        return Object.freeze({ run: next.run, bytes: stored.bytes });
      }
      return Object.freeze({ run: stored.run, bytes: stored.bytes });
    }

    const backupId = this.#createBackupId();
    if (!BACKUP_ID.test(backupId)) throw unavailable("Backup identity source failed");
    const reservation = await this.trust.reserve(backupId);
    let persisted = false;
    let ownedEnvelope: Uint8Array | null = null;
    try {
      const exported = await this.authority.exportAuthenticatedArchive(reservation);
      ownedEnvelope = exported.bytes;
      const selection = await this.authority.backupSelection();
      const metadata = this.authority.backupMetadata();
      if (target.appInstanceId !== selection.selected.selectedAppInstanceId
          || !sameTarget(exported.target, selection.selected.target)
          || exported.catalogGeneration !== selection.selected.catalogGeneration)
        throw unavailable("Selected target changed while preparing automatic backup");
      const run = BackupRunV1.parse({
        schema: 1,
        backupId,
        generationId: this.#createGenerationId(),
        target,
        expected: selection.selected,
        fence: selection.fence,
        reason,
        attempt: "fresh",
        fileLabel: metadata.fileLabel,
        createdAt: this.#now(),
        archive: {
          format: 5,
          byteLength: exported.bytes.byteLength,
          archiveSha256: await sha256(exported.bytes),
          authentication: exported.authentication,
          shapeHead: metadata.shapeHead,
          shapeCurrent: metadata.shapeCurrent,
        },
      });
      const candidate: StoredAutomaticBackupCandidate = Object.freeze({
        schema: 1,
        revision: "0",
        seriesId,
        backupId,
        generation: reservation.generation.toString(),
        phase: "prepared",
        run,
        bytes: exported.bytes,
      });
      if (!(await this.trust.compareAndSetAutomaticBackupCandidate(
        seriesId, null, candidate,
      ))) {
        exported.bytes.fill(0);
        ownedEnvelope = null;
        const winner = parseStoredCandidate(
          await this.trust.loadAutomaticBackupCandidate(seriesId),
          seriesId,
          { backupId, generation: reservation.generation.toString() },
        );
        if (await sha256(winner.bytes) !== winner.run.archive.archiveSha256)
          throw unavailable("Concurrent automatic-backup candidate digest is invalid");
        return Object.freeze({ run: winner.run, bytes: winner.bytes });
      }
      persisted = true;
      return Object.freeze({ run, bytes: exported.bytes });
    } catch (error) {
      if (!persisted) await this.trust.abandon(
        bytesToHex(reservation.seriesId), backupId, reservation.generation,
      );
      throw error;
    } finally {
      if (!persisted) ownedEnvelope?.fill(0);
      reservation.backupTrustKey.fill(0);
      reservation.keyId.fill(0);
      reservation.seriesId.fill(0);
    }
  }

  /**
   * Manual download uses the same authenticated envelope and monotonic trust
   * chain as automatic backup. It is authenticated in the trusted shell and
   * its payload is inspected in the worker over the private verifier channel
   * before ownership of the one envelope buffer is transferred to the UI.
   */
  async prepareManualDownload(): Promise<PreparedManualBackup> {
    return withBackupTrustLock(() => this.#prepareManualDownload());
  }

  async #prepareManualDownload(): Promise<PreparedManualBackup> {
    const status = await this.trust.status();
    if (status.status !== "ready")
      throw unavailable("Portable export requires completed Recovery Kit enrollment");
    if (status.pending) {
      const candidate = await this.trust.loadAutomaticBackupCandidate(status.seriesId);
      if (candidate === null) {
        await this.trust.abandon(
          status.seriesId, status.pending.backupId, BigInt(status.pending.generation),
        );
        throw unavailable(
          "An interrupted Backup Trust generation was abandoned; retry the portable export",
        );
      }
      throw unavailable("Finish or retry the pending automatic backup before portable export");
    }
    if (await this.trust.loadAutomaticBackupCandidate(status.seriesId))
      throw unavailable("Finish automatic backup retention before portable export");

    const backupId = this.#createBackupId();
    if (!BACKUP_ID.test(backupId)) throw unavailable("Backup identity source failed");
    const reservation = await this.trust.reserve(backupId);
    let committed = false;
    let delivered = false;
    let ownedEnvelope: Uint8Array | null = null;
    let header: ReturnType<typeof inspectAuthenticatedArchiveV5Header> | null = null;
    try {
      const exported = await this.authority.exportAuthenticatedArchive(reservation);
      ownedEnvelope = exported.bytes;
      const selection = await this.authority.backupSelection();
      if (!sameTarget(exported.target, selection.selected.target)
          || exported.catalogGeneration !== selection.selected.catalogGeneration)
        throw unavailable("Selected target changed while preparing portable export");
      header = inspectAuthenticatedArchiveV5Header(exported.bytes);
      if (!authenticationMatchesHeader(exported.authentication, header))
        throw unavailable("Portable export authentication header is inconsistent");
      const stage = BackupStageValidationV1.parse(
        await this.authority.validateAuthenticatedArchiveStage(
          exported.bytes, exported.target, reservation.backupTrustKey,
        ),
      );
      if (stage.status !== "valid" || !sameTarget(stage.evidence, exported.target)
          || !authenticationMatchesHeader(stage.authentication, header))
        throw unavailable("Portable export failed authenticated read-back");
      await this.trust.commit(
        status.seriesId, backupId, reservation.generation, exported.bytes,
      );
      committed = true;
      if (await this.trust.assess(header, exported.bytes) !== "current")
        throw unavailable("Portable export freshness failed read-back");
      delivered = true;
      return Object.freeze({
        format: 5 as const,
        bytes: exported.bytes,
        filename: exported.filename,
        target: exported.target,
        catalogGeneration: exported.catalogGeneration,
        authentication: exported.authentication,
      });
    } catch (error) {
      if (!committed) await this.trust.abandon(
        bytesToHex(reservation.seriesId), backupId, reservation.generation,
      );
      throw error;
    } finally {
      if (!delivered) ownedEnvelope?.fill(0);
      reservation.backupTrustKey.fill(0);
      reservation.keyId.fill(0);
      reservation.seriesId.fill(0);
      header?.keyId.fill(0);
      header?.seriesId.fill(0);
    }
  }

  async validateStage(
    bytesInput: Uint8Array,
    expectedInput: TargetEvidence,
  ): Promise<BackupStageValidation> {
    return withBackupTrustLock(() => this.#validateStage(bytesInput, expectedInput));
  }

  async #validateStage(bytesInput: Uint8Array, expectedInput: TargetEvidence): Promise<BackupStageValidation> {
    if (!(bytesInput instanceof Uint8Array)
        || Object.getPrototypeOf(bytesInput) !== Uint8Array.prototype)
      throw unavailable("Automatic backup read-back bytes are malformed");
    // The trusted shell owns this readback. The DB worker receives only the
    // private verifier channel and authenticated payload, never key material.
    const bytes = bytesInput;
    let retainedForPublication = false;
    const header = inspectAuthenticatedArchiveV5Header(bytes);
    const seriesId = bytesToHex(header.seriesId);
    const key = await this.trust.keyForSeries(seriesId);
    if (!key) throw unavailable("Recovery Kit for this backup series is not enrolled");
    try {
      const stage = BackupStageValidationV1.parse(
        await this.authority.validateAuthenticatedArchiveStage(bytes, expectedInput, key),
      );
      if (stage.status !== "valid" || !sameTarget(stage.evidence, expectedInput)
          || !authenticationMatchesHeader(stage.authentication, header))
        return { schema: 1, status: "invalid", evidence: null };
      const digest = await sha256(bytes);
      const trustStatus = await this.trust.status();
      const reservation = trustStatus.status === "ready" ? trustStatus.pending ?? trustStatus.committed : null;
      if (trustStatus.status !== "ready" || trustStatus.seriesId !== seriesId || !reservation
          || reservation.generation !== header.generation.toString())
        throw unavailable("Backup Trust reservation changed during staged validation");
      const candidate = parseStoredCandidate(
        await this.trust.loadAutomaticBackupCandidate(seriesId),
        seriesId,
        reservation,
      );
      if (candidate.run.archive.archiveSha256 !== digest)
        throw unavailable("Staged bytes do not match the durable backup candidate");
      if (candidate.phase === "prepared") {
        const next = Object.freeze({
          ...candidate,
          revision: nextCandidateRevision(candidate.revision),
          phase: "staged" as const,
        });
        if (!(await this.trust.compareAndSetAutomaticBackupCandidate(
          seriesId, candidate.revision, next,
        ))) throw unavailable("Durable staged backup candidate changed concurrently");
      }
      const replaced = this.#staged.get(digest);
      if (replaced && replaced !== bytes) replaced.fill(0);
      this.#staged.set(digest, bytes);
      retainedForPublication = true;
      while (this.#staged.size > MAX_STAGED_ENVELOPES) {
        const oldest = this.#staged.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        const removed = this.#staged.get(oldest);
        removed?.fill(0);
        this.#staged.delete(oldest);
      }
      return stage;
    } finally {
      key.fill(0);
      header.keyId.fill(0);
      header.seriesId.fill(0);
      if (!retainedForPublication) bytes.fill(0);
    }
  }

  async publish(requestInput: BackupPublicationRequest): Promise<BackupPublicationReceipt> {
    return withBackupTrustLock(() => this.#publish(requestInput));
  }

  async #publish(requestInput: BackupPublicationRequest): Promise<BackupPublicationReceipt> {
    const request = BackupPublicationRequestV1.parse(requestInput);
    const status = await this.trust.status();
    const artifact = request.artifact;
    const pending = status.status === "ready" && status.pending?.backupId === artifact.backupId
      && status.pending.generation === artifact.authentication.generation;
    const committed = status.status === "ready" && status.committed?.backupId === artifact.backupId
      && status.committed.generation === artifact.authentication.generation && status.committed.envelopeSha256 === artifact.archiveSha256;
    if (status.status !== "ready" || status.seriesId !== artifact.authentication.seriesId
        || status.keyId !== artifact.authentication.keyId || (!pending && !committed))
      throw unavailable("Backup Trust candidate changed before publication; stale effects are denied");
    const envelope = this.#staged.get(request.artifact.archiveSha256);
    if (!envelope) {
      // After a successful publication/response loss the byte cache may already
      // be released. Only the exact durable trust commit AND catalog artifact
      // can substitute for that ephemeral proof; arbitrary historic requests
      // cannot publish new metadata this way.
      const trust = await this.trust.status();
      const artifact = request.artifact;
      const record = (await this.authority.backupRecords()).find(item => item.backupId === artifact.backupId);
      if (trust.status === "ready" && trust.committed?.backupId === artifact.backupId
          && trust.committed.generation === artifact.authentication.generation
          && trust.committed.envelopeSha256 === artifact.archiveSha256
          && trust.seriesId === artifact.authentication.seriesId && trust.keyId === artifact.authentication.keyId
          && record?.state === "valid"
          && JSON.stringify(Object.fromEntries(Object.keys(artifact).map(key => [key, Reflect.get(record, key)]))) === JSON.stringify(artifact))
        return this.authority.publishBackup(request);
      throw unavailable("Authenticated backup read-back has not been staged for publication");
    }
    if (envelope.byteLength !== request.artifact.byteLength)
      throw unavailable("Authenticated backup read-back has not been staged for publication");
    const header = inspectAuthenticatedArchiveV5Header(envelope);
    try {
      if (!authenticationMatchesHeader(request.artifact.authentication, header))
        throw unavailable("Backup publication authentication does not match staged bytes");
      const receipt = await this.authority.publishBackup(request);
      await this.trust.commit(
        bytesToHex(header.seriesId),
        request.artifact.backupId,
        header.generation,
        envelope,
      );
      const freshness = await this.trust.assess(header, envelope);
      if (freshness !== "current")
        throw unavailable("Published backup freshness failed read-back");
      // Physical retention happens after this receipt. Keep the immutable
      // candidate until its exact successful completion is acknowledged.
      this.#staged.delete(request.artifact.archiveSha256);
      envelope.fill(0);
      return receipt;
    } finally {
      header.keyId.fill(0);
      header.seriesId.fill(0);
    }
  }

  records(): Promise<BackupRecord[]> {
    return this.authority.backupRecords();
  }

  async complete(input: unknown): Promise<void> {
    const result = BackupResultV1.parse(input);
    if (result.status !== "published" || result.rotation.failed !== 0
        || result.rotation.deleted !== result.rotation.requested) return;
    return withBackupTrustLock(async () => {
      const status = await this.trust.status(); const record = result.record;
      if (status.status !== "ready" || status.seriesId !== record.authentication.seriesId
          || status.committed?.backupId !== record.backupId
          || status.committed.envelopeSha256 !== record.archiveSha256)
        throw unavailable("Backup completion does not match the active committed candidate");
      const published = (await this.authority.backupRecords()).find(item => item.backupId === record.backupId);
      if (JSON.stringify(published) !== JSON.stringify(record))
        throw unavailable("Backup completion lacks its exact durable publication");
      const input = await this.trust.loadAutomaticBackupCandidate(status.seriesId);
      if (input === null) return; // Exact publication/trust readback makes acknowledgement replay safe.
      const candidate = parseStoredCandidate(input, status.seriesId, status.committed);
      if (!matchesCandidate(record, candidate)
          || !(await this.trust.removeAutomaticBackupCandidate(status.seriesId, candidate.revision)))
        throw unavailable("Published durable backup candidate cleanup needs retry");
      candidate.bytes.fill(0);
    });
  }

  /** User-confirmed recovery from a partial/colliding external file. This retires
   * only a proven unpublished trust reservation. It never opens or deletes files. */
  async retire(seriesId: string, backupId: string,
    confirmation: "keep_existing_files_and_retire_unpublished_attempt"): Promise<void> {
    if (!/^[0-9a-f]{32}$/.test(seriesId) || !BACKUP_ID.test(backupId)
        || confirmation !== "keep_existing_files_and_retire_unpublished_attempt")
      throw unavailable("Explicit exact backup retirement confirmation is required");
    return withBackupTrustLock(async () => {
      const status = await this.trust.status();
      if (status.status !== "ready" || status.seriesId !== seriesId || status.pending?.backupId !== backupId)
        throw unavailable("Pending backup changed; refresh Recovery Center");
      if ((await this.authority.backupRecords()).some(record => record.backupId === backupId))
        throw unavailable("This backup was already published. Retry publication and retention instead.");
      const input = await this.trust.loadAutomaticBackupCandidate(seriesId);
      const candidate = input === null ? null : parseStoredCandidate(input, seriesId, status.pending);
      await this.trust.abandon(seriesId, backupId, BigInt(status.pending.generation));
      if (candidate) {
        if (!(await this.trust.removeAutomaticBackupCandidate(seriesId, candidate.revision)))
          throw unavailable("Retired backup cleanup needs retry. Existing files kept.");
        candidate.bytes.fill(0); this.#staged.get(candidate.run.archive.archiveSha256)?.fill(0);
        this.#staged.delete(candidate.run.archive.archiveSha256);
      }
    });
  }
}
