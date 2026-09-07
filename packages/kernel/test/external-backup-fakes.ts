import type {
  BackupPublicationReceipt,
  BackupPublicationRequest,
  BackupRecord,
  BackupRun,
  BackupSelectedTarget,
  BackupStageValidation,
  BackupTarget,
} from "../src/backup";
import type {
  ExternalBackupAuthority,
  ExternalBackupDirectory,
  ExternalBackupWriter,
  IsolatedArchiveStageValidator,
} from "../src/external-backup";
import { sha256HexSync } from "../src/state-digest";

export const id = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;
export const digestBytes = (bytes: Uint8Array): string => `sha256:${sha256HexSync(bytes)}`;

export const EVIDENCE = {
  appInstanceId: id("app", "a"),
  activeGenerationId: id("gen", "b"),
  lineageEpoch: "4",
  protectionRevision: "11",
  digestSchema: 1 as const,
  stateSha256: `sha256:${"c".repeat(64)}`,
};

export const AUTHENTICATION = {
  schema: 1 as const,
  kind: "cose_mac0_hmac_256_256" as const,
  authenticationVersion: 1 as const,
  keyId: "10".repeat(16),
  seriesId: "20".repeat(16),
  generation: "9",
};

export const SELECTED: BackupSelectedTarget = {
  schema: 1,
  authorityIncarnationId: id("auth", "d"),
  catalogGeneration: "30",
  writeEpoch: "7",
  selectedAppInstanceId: EVIDENCE.appInstanceId,
  selectedActiveGenerationId: EVIDENCE.activeGenerationId,
  target: EVIDENCE,
};

export const TARGET: BackupTarget = {
  schema: 1,
  targetId: id("tgt", "e"),
  appInstanceId: EVIDENCE.appInstanceId,
  adapter: "browser_directory",
  adapterCertificationId: id("btc", "f"),
  authorizedAt: "2026-09-05T20:00:00.000Z",
};

export function backupRun(bytes: Uint8Array): BackupRun {
  return {
    schema: 1,
    backupId: id("bkp", "g"),
    generationId: id("backupgen", "h"),
    target: TARGET,
    expected: SELECTED,
    fence: {
      authorityIncarnationId: SELECTED.authorityIncarnationId,
      writeEpoch: SELECTED.writeEpoch,
      leaseId: id("lease", "i"),
      releaseId: id("rel", "j"),
    },
    reason: "meaningful_write",
    attempt: "fresh",
    fileLabel: "Field Ops",
    createdAt: "2026-09-05T20:01:02.003Z",
    archive: {
      format: 5,
      byteLength: bytes.byteLength,
      archiveSha256: digestBytes(bytes),
      authentication: AUTHENTICATION,
      shapeHead: 9,
      shapeCurrent: 8,
    },
  };
}

class ClosedFakeIoError extends Error {
  constructor(readonly reasonCode: string) {
    super("closed fake I/O failure");
  }
}

export class DeterministicDirectory implements ExternalBackupDirectory {
  readonly files = new Map<string, Uint8Array>();
  readonly events: string[];
  createFailure: string | null = null;
  writeFailure: string | null = null;
  closeFailure: string | null = null;
  readFailure: string | null = null;
  shortWrite = false;
  shortRead = false;
  corruptRead = false;
  readonly removeFailures = new Set<string>();

  constructor(
    readonly targetId: string,
    events: string[] = [],
  ) {
    this.events = events;
  }

  async createNew(fileName: string): Promise<ExternalBackupWriter> {
    this.events.push(`directory:create:${fileName}`);
    if (this.createFailure) throw new ClosedFakeIoError(this.createFailure);
    if (this.files.has(fileName)) throw new ClosedFakeIoError("destination_collision");
    this.files.set(fileName, new Uint8Array());
    let closed = false;
    return {
      write: async (bytes: Uint8Array): Promise<void> => {
        this.events.push(`directory:write:${bytes.byteLength}`);
        if (closed) throw new ClosedFakeIoError("target_unreachable");
        if (this.writeFailure) throw new ClosedFakeIoError(this.writeFailure);
        const length = this.shortWrite ? Math.max(0, bytes.byteLength - 1) : bytes.byteLength;
        this.files.set(fileName, bytes.slice(0, length));
      },
      close: async (): Promise<void> => {
        this.events.push("directory:close");
        if (closed) throw new ClosedFakeIoError("target_unreachable");
        closed = true;
        if (this.closeFailure) throw new ClosedFakeIoError(this.closeFailure);
      },
    };
  }

  async readExact(fileName: string): Promise<Uint8Array> {
    this.events.push(`directory:read:${fileName}`);
    if (this.readFailure) throw new ClosedFakeIoError(this.readFailure);
    const stored = this.files.get(fileName);
    if (!stored) throw new ClosedFakeIoError("target_unreachable");
    let result = stored.slice();
    if (this.shortRead) result = result.slice(0, Math.max(0, result.byteLength - 1));
    if (this.corruptRead && result.byteLength > 0) result[result.byteLength - 1]! ^= 0xff;
    return result;
  }

  async removeExact(fileName: string): Promise<void> {
    this.events.push(`directory:remove:${fileName}`);
    if (this.removeFailures.has(fileName))
      throw new ClosedFakeIoError("target_unreachable");
    if (!this.files.delete(fileName)) throw new ClosedFakeIoError("target_unreachable");
  }
}

function nextGeneration(value: string): string {
  return String(BigInt(value) + 1n);
}

export class DeterministicBackupAuthority implements ExternalBackupAuthority {
  readonly events: string[];
  selected: BackupSelectedTarget;
  rotate: BackupRecord[] = [];
  failBeforePublication = false;
  loseNextPublicationResponse = false;
  readonly records = new Map<string, BackupRecord>();
  readonly requests: BackupPublicationRequest[] = [];

  constructor(
    selected: BackupSelectedTarget = SELECTED,
    events: string[] = [],
  ) {
    this.selected = structuredClone(selected);
    this.events = events;
  }

  async readSelectedTarget(): Promise<unknown> {
    this.events.push("authority:read-selection");
    return structuredClone(this.selected);
  }

  async publish(request: BackupPublicationRequest): Promise<unknown> {
    this.events.push("authority:publish");
    this.requests.push(structuredClone(request));
    if (this.failBeforePublication) throw new Error("publication failed");
    const prior = this.records.get(request.artifact.backupId);
    if (prior) {
      const receipt: BackupPublicationReceipt = {
        schema: 1,
        publication: "already_published",
        record: structuredClone(prior),
        rotate: structuredClone(this.rotate),
      };
      return receipt;
    }
    const publicationCatalogGeneration = nextGeneration(request.expected.catalogGeneration);
    const record: BackupRecord = {
      ...request.artifact,
      publicationCatalogGeneration,
      state: "valid",
      validationCode: "archive_valid",
    };
    this.records.set(record.backupId, structuredClone(record));
    this.selected = {
      ...this.selected,
      catalogGeneration: publicationCatalogGeneration,
    };
    if (this.loseNextPublicationResponse) {
      this.loseNextPublicationResponse = false;
      throw new Error("response lost after commit");
    }
    const receipt: BackupPublicationReceipt = {
      schema: 1,
      publication: "published",
      record,
      rotate: structuredClone(this.rotate),
    };
    return receipt;
  }
}

export class DeterministicStageValidator {
  readonly events: string[];
  invalid = false;
  throws = false;
  evidence = EVIDENCE;
  authentication = AUTHENTICATION;
  observedBytes: Uint8Array | null = null;

  constructor(events: string[] = []) {
    this.events = events;
  }

  readonly validate: IsolatedArchiveStageValidator = async (
    bytes,
  ): Promise<BackupStageValidation> => {
    this.events.push("stage:validate");
    this.observedBytes = bytes.slice();
    if (this.throws) throw new Error("isolated stage failed");
    return this.invalid
      ? { schema: 1, status: "invalid", evidence: null }
      : {
          schema: 1,
          status: "valid",
          evidence: structuredClone(this.evidence),
          authentication: structuredClone(this.authentication),
        };
  };
}

export function historicalRecord(
  generationChar: string,
  fileName: string,
  createdAt: string,
): BackupRecord {
  return {
    schema: 1,
    backupId: id("bkp", generationChar),
    generationId: id("backupgen", generationChar),
    targetId: TARGET.targetId,
    evidence: EVIDENCE,
    publicationCatalogGeneration: "20",
    fileName,
    createdAt,
    validatedAt: createdAt,
    shapeHead: 5,
    shapeCurrent: 5,
    archiveFormat: 5,
    byteLength: 3,
    archiveSha256: digestBytes(new Uint8Array([1, 2, 3])),
    authentication: AUTHENTICATION,
    adapterCertificationId: TARGET.adapterCertificationId,
    state: "valid",
    validationCode: "archive_valid",
  };
}
