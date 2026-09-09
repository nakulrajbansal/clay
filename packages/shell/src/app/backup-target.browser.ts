import {
  AutomaticBackupFileName,
  BackupAdapterArtifactBindingV1,
  BackupTargetAdapterCertificationV1,
  BackupTargetId,
  BackupTargetV1,
  type BackupAdapterArtifactBinding,
  type BackupTarget,
  type BackupTargetAdapterCertification,
  type ExternalBackupDirectory,
  type ExternalBackupWriter,
} from "@clay/kernel/backup";

type BrowserPermission = "granted" | "prompt" | "denied";
type PermissionDescriptor = { mode: "readwrite" };

export interface BrowserWritableFileStream {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

export interface BrowserFileHandle {
  readonly kind: "file";
  readonly name: string;
  createWritable(options?: {
    keepExistingData?: boolean;
    mode?: "exclusive" | "siloed";
  }): Promise<BrowserWritableFileStream>;
  getFile(): Promise<{
    readonly size: number;
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
}

export interface BrowserDirectoryHandle {
  readonly kind: "directory";
  readonly name: string;
  queryPermission(descriptor: PermissionDescriptor): Promise<BrowserPermission>;
  requestPermission?(descriptor: PermissionDescriptor): Promise<BrowserPermission>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<BrowserFileHandle>;
  removeEntry(name: string): Promise<void>;
}

export type BrowserExclusiveFileReservation = Readonly<{
  fileHandle: BrowserFileHandle;
  writable: BrowserWritableFileStream;
  release(): void;
}>;

/** Injected only by a certified host that can reserve a never-overwritten file. */
export type BrowserExclusiveFileCreator = (
  directory: BrowserDirectoryHandle,
  name: string,
) => Promise<BrowserFileHandle | BrowserExclusiveFileReservation>;

type BrowserLockManager = {
  request<T>(
    name: string,
    options: { mode: "exclusive" },
    callback: () => Promise<T>,
  ): Promise<T>;
};

function isNotFound(error: unknown): boolean {
  return isNamedDomFailure(error, ["NotFoundError"]);
}

/**
 * Chromium's production bridge holds a same-origin Web Lock and an exclusive
 * FileSystemWritableFileStream for the complete write. It never opens a
 * pre-existing nonempty file for replacement and therefore cannot truncate a
 * colliding backup. The generated 130-bit filename identity makes a hostile
 * pre-created empty-name collision infeasible; such a file contains no data to
 * destroy, and exact read-back still gates publication.
 */
export function createChromiumExclusiveFileCreator(
  locks: BrowserLockManager,
): BrowserExclusiveFileCreator {
  return (directory, name) => new Promise((resolve, reject) => {
    const lockName = `clay-backup-exclusive-v1:${directory.name}:${name}`;
    void locks.request(lockName, { mode: "exclusive" }, async () => {
      let release!: () => void;
      const held = new Promise<void>(done => { release = done; });
      let created = false;
      let writable: BrowserWritableFileStream | null = null;
      try {
        try {
          await requireReadWritePermission(directory);
          await directory.getFileHandle(name);
          throw new BackupDirectoryIoError("destination_collision");
        } catch (error) {
          if (error instanceof BackupDirectoryIoError) throw error;
          if (!isNotFound(error)) throw error;
        }
        await requireReadWritePermission(directory);
        const fileHandle = await directory.getFileHandle(name, { create: true });
        created = true;
        await requireReadWritePermission(directory);
        writable = await fileHandle.createWritable({
          keepExistingData: true,
          mode: "exclusive",
        });
        await requireReadWritePermission(directory);
        const snapshot = await fileHandle.getFile();
        if (snapshot.size !== 0)
          throw new BackupDirectoryIoError("destination_collision");
        resolve(Object.freeze({ fileHandle, writable, release }));
        await held;
      } catch (error) {
        try {
          if (writable) await requireReadWritePermission(directory);
          if (writable?.abort) await writable.abort();
          else if (writable) await writable.close();
        } catch { /* release owns the first closed failure */ }
        if (created) {
          try {
            await requireReadWritePermission(directory);
            await directory.removeEntry(name);
          } catch { /* exact owned cleanup */ }
        }
        reject(error);
      }
    }).catch(reject);
  });
}

/** IndexedDB-like storage. `save` receives the handle itself for structured cloning. */
export interface DirectoryHandleStore {
  load(targetId: string): Promise<BrowserDirectoryHandle | null>;
  save(targetId: string, handle: BrowserDirectoryHandle): Promise<void>;
  remove(targetId: string): Promise<void>;
}

export interface ChromiumBackupEnvironment {
  readonly secureContext: boolean;
  readonly topLevelContext: boolean;
  hasTransientUserActivation(): boolean;
  readonly showDirectoryPicker: (() => Promise<BrowserDirectoryHandle>) | undefined;
  readonly createExclusiveFile: BrowserExclusiveFileCreator | undefined;
}

/** Feature-detected production environment; calling this never opens a picker. */
export function chromiumBackupEnvironmentFromGlobals(): ChromiumBackupEnvironment {
  const picker = Reflect.get(globalThis, "showDirectoryPicker");
  let topLevelContext = false;
  try {
    topLevelContext = typeof window !== "undefined" && window.self === window.top;
  } catch {
    topLevelContext = false;
  }
  const showDirectoryPicker = typeof picker === "function"
    ? async (): Promise<BrowserDirectoryHandle> => {
      const handle: unknown = await Reflect.apply(
        picker, globalThis, [{ mode: "readwrite" }],
      );
      if (!isDirectoryHandle(handle))
        throw new DOMException("directory picker returned no directory handle", "NotSupportedError");
      return handle;
    }
    : undefined;
  const navigatorValue = Reflect.get(globalThis, "navigator");
  const locksValue = navigatorValue && typeof navigatorValue === "object"
    ? Reflect.get(navigatorValue, "locks") : undefined;
  const locks = locksValue && typeof locksValue === "object"
      && typeof Reflect.get(locksValue, "request") === "function"
    ? locksValue as BrowserLockManager : null;
  return {
    secureContext: globalThis.isSecureContext === true,
    topLevelContext,
    hasTransientUserActivation: () => {
      const currentNavigator = Reflect.get(globalThis, "navigator");
      if (!currentNavigator || typeof currentNavigator !== "object") return false;
      const activation = Reflect.get(currentNavigator, "userActivation");
      return !!activation && typeof activation === "object"
        && Reflect.get(activation, "isActive") === true;
    },
    showDirectoryPicker,
    createExclusiveFile: locks ? createChromiumExclusiveFileCreator(locks) : undefined,
  };
}

export type BackupAdapterUnavailableReason =
  | "unsupported_api"
  | "adapter_uncertified"
  | "insecure_context"
  | "not_top_level"
  | "gesture_required";

export type BackupAdapterAvailability =
  | { status: "available" }
  | { status: "unavailable"; reasonCode: BackupAdapterUnavailableReason };

export type BackupTargetAuthorization =
  | { status: "authorized"; target: BackupTarget }
  | {
    status: "unavailable";
    reasonCode: BackupAdapterUnavailableReason | "permission_required" | "target_unconfigured"
      | "target_unreachable" | "operation_interrupted";
  };

export type BackupDirectoryFailureReason =
  | "adapter_uncertified"
  | "unsupported_api"
  | "target_unconfigured"
  | "permission_required"
  | "target_unreachable"
  | "quota_exceeded"
  | "destination_collision"
  | "operation_interrupted";

export class BackupDirectoryIoError extends Error {
  readonly reasonCode: BackupDirectoryFailureReason;

  constructor(reasonCode: BackupDirectoryFailureReason) {
    super("external backup directory operation failed");
    this.name = "BackupDirectoryIoError";
    this.reasonCode = reasonCode;
  }
}

export type BackupDirectoryWriter = ExternalBackupWriter;
export type BrowserBackupDirectory = ExternalBackupDirectory;

function isNamedDomFailure(error: unknown, names: readonly string[]): boolean {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return false;
  const name = Reflect.get(error, "name");
  return typeof name === "string" && names.includes(name);
}

function mapIoFailure(
  error: unknown,
  fallback: BackupDirectoryFailureReason = "target_unreachable",
): BackupDirectoryIoError {
  if (error instanceof BackupDirectoryIoError) return error;
  if (isNamedDomFailure(error, ["NotAllowedError", "SecurityError"]))
    return new BackupDirectoryIoError("permission_required");
  if (isNamedDomFailure(error, ["QuotaExceededError"]))
    return new BackupDirectoryIoError("quota_exceeded");
  if (isNamedDomFailure(error, ["AbortError"]))
    return new BackupDirectoryIoError("operation_interrupted");
  if (isNamedDomFailure(error, ["InvalidModificationError", "NoModificationAllowedError"]))
    return new BackupDirectoryIoError("destination_collision");
  return new BackupDirectoryIoError(fallback);
}

function isDirectoryHandle(value: unknown): value is BrowserDirectoryHandle {
  if (!value || typeof value !== "object") return false;
  return Reflect.get(value, "kind") === "directory"
    && typeof Reflect.get(value, "queryPermission") === "function"
    && typeof Reflect.get(value, "getFileHandle") === "function"
    && typeof Reflect.get(value, "removeEntry") === "function";
}

function isDirectoryFileHandle(value: unknown): value is BrowserFileHandle {
  return !!value && typeof value === "object" && Reflect.get(value, "kind") === "file"
    && typeof Reflect.get(value, "createWritable") === "function"
    && typeof Reflect.get(value, "getFile") === "function";
}

function isExclusiveReservation(value: unknown): value is BrowserExclusiveFileReservation {
  return !!value && typeof value === "object"
    && isDirectoryFileHandle(Reflect.get(value, "fileHandle"))
    && typeof Reflect.get(value, "writable") === "object"
    && typeof Reflect.get(value, "release") === "function";
}

function permissionDescriptor(): PermissionDescriptor {
  return { mode: "readwrite" };
}

async function requireReadWritePermission(handle: BrowserDirectoryHandle): Promise<void> {
  let permission: BrowserPermission;
  try {
    permission = await handle.queryPermission(permissionDescriptor());
  } catch (error) {
    throw mapIoFailure(error);
  }
  if (permission !== "granted") throw new BackupDirectoryIoError("permission_required");
}

async function requestReadWritePermissionFromGesture(
  handle: BrowserDirectoryHandle,
): Promise<boolean> {
  let permission: BrowserPermission;
  try {
    permission = await handle.queryPermission(permissionDescriptor());
    if (permission === "granted") return true;
    if (!handle.requestPermission) return false;
    permission = await handle.requestPermission(permissionDescriptor());
  } catch {
    return false;
  }
  return permission === "granted";
}

function validateFileName(fileName: string): string {
  const parsed = AutomaticBackupFileName.safeParse(fileName);
  if (!parsed.success) throw new BackupDirectoryIoError("destination_collision");
  return parsed.data;
}

class TargetDirectory implements BrowserBackupDirectory {
  readonly targetId: string;

  constructor(
    private readonly owner: ChromiumBackupDirectoryAdapter,
    private readonly target: BackupTarget,
    private readonly createExclusiveFile: BrowserExclusiveFileCreator | undefined,
  ) {
    this.targetId = target.targetId;
  }

  async createNew(fileNameInput: string): Promise<BackupDirectoryWriter> {
    const fileName = validateFileName(fileNameInput);
    const handle = await this.owner.reacquire(this.target);

    let fileHandle: BrowserFileHandle;
    let writable: BrowserWritableFileStream | null = null;
    let releaseReservation: (() => void) | null = null;
    try {
      if (!this.createExclusiveFile) throw new BackupDirectoryIoError("unsupported_api");
      await requireReadWritePermission(handle);
      const created = await this.createExclusiveFile(handle, fileName);
      if (isExclusiveReservation(created)) {
        fileHandle = created.fileHandle;
        writable = created.writable;
        releaseReservation = created.release;
      } else if (isDirectoryFileHandle(created)) {
        fileHandle = created;
      } else {
        throw new BackupDirectoryIoError("unsupported_api");
      }
    } catch (error) {
      throw mapIoFailure(error);
    }

    if (!writable) {
      try {
        // A native O_EXCL bridge may return only the newly-created handle.
        await requireReadWritePermission(handle);
        writable = await fileHandle.createWritable({ keepExistingData: false });
      } catch (error) {
        releaseReservation?.();
        throw mapIoFailure(error);
      }
    }

    const reservedWritable = writable;
    let closed = false;
    return {
      write: async (input: Uint8Array): Promise<void> => {
        if (closed || !(input instanceof Uint8Array))
          throw new BackupDirectoryIoError("target_unreachable");
        try {
          // The automatic-backup boundary transfers sole ownership and waits
          // for this promise before releasing it. Do not duplicate a possible
          // 384 MiB archive in the browser presentation process.
          await requireReadWritePermission(handle);
          await reservedWritable.write(input);
        } catch (error) {
          throw mapIoFailure(error);
        }
      },
      close: async (): Promise<void> => {
        if (closed) throw new BackupDirectoryIoError("target_unreachable");
        closed = true;
        try {
          // Closing commits the external stream, so revoke authority unless a
          // fresh read/write query is still granted at that exact boundary.
          await requireReadWritePermission(handle);
          await reservedWritable.close();
        } catch (error) {
          try { await reservedWritable.abort?.(); } catch { /* first error wins */ }
          throw mapIoFailure(error);
        } finally {
          releaseReservation?.();
        }
      },
    };
  }

  async readExact(fileNameInput: string): Promise<Uint8Array> {
    const fileName = validateFileName(fileNameInput);
    const handle = await this.owner.reacquire(this.target);
    try {
      await requireReadWritePermission(handle);
      const fileHandle = await handle.getFileHandle(fileName);
      await requireReadWritePermission(handle);
      const file = await fileHandle.getFile();
      await requireReadWritePermission(handle);
      const buffer = await file.arrayBuffer();
      return new Uint8Array(buffer);
    } catch (error) {
      throw mapIoFailure(error);
    }
  }

  async removeExact(fileNameInput: string): Promise<void> {
    const fileName = validateFileName(fileNameInput);
    const handle = await this.owner.reacquire(this.target);
    try {
      await requireReadWritePermission(handle);
      await handle.removeEntry(fileName);
    } catch (error) {
      throw mapIoFailure(error);
    }
  }
}

function artifactBindingEquals(
  left: BackupAdapterArtifactBinding,
  right: BackupAdapterArtifactBinding,
): boolean {
  return left.implementationId === right.implementationId
    && left.implementationVersion === right.implementationVersion
    && left.codeSha256 === right.codeSha256
    && left.releaseId === right.releaseId
    && left.buildSha256 === right.buildSha256
    && left.runtime.distribution === right.runtime.distribution
    && left.runtime.osFamily === right.runtime.osFamily
    && left.runtime.osVersion === right.runtime.osVersion
    && left.runtime.runtimeFamily === right.runtime.runtimeFamily
    && left.runtime.runtimeVersion === right.runtime.runtimeVersion
    && left.runtime.architecture === right.runtime.architecture
    && left.matrixId === right.matrixId
    && left.matrixSha256 === right.matrixSha256
    && left.suiteId === right.suiteId
    && left.suiteSha256 === right.suiteSha256;
}

export interface ChromiumBackupDirectoryAdapterOptions {
  environment: ChromiumBackupEnvironment;
  handleStore: DirectoryHandleStore;
  certification: unknown;
  expectedBinding: unknown;
  createTargetId(): string;
  now(): string;
}

/**
 * Browser File System Access adapter. Unattended operations expose no method
 * that can request permission; only the two explicitly gesture-named methods do.
 */
export class ChromiumBackupDirectoryAdapter {
  private readonly environment: ChromiumBackupEnvironment;
  private readonly handleStore: DirectoryHandleStore;
  private readonly certification: BackupTargetAdapterCertification | null;
  private readonly expectedBinding: BackupAdapterArtifactBinding | null;
  private readonly createTargetId: () => string;
  private readonly clock: () => string;

  constructor(options: ChromiumBackupDirectoryAdapterOptions) {
    this.environment = options.environment;
    this.handleStore = options.handleStore;
    const certification = BackupTargetAdapterCertificationV1.safeParse(options.certification);
    const binding = BackupAdapterArtifactBindingV1.safeParse(options.expectedBinding);
    this.certification = certification.success ? certification.data : null;
    this.expectedBinding = binding.success ? binding.data : null;
    this.createTargetId = options.createTargetId;
    this.clock = options.now;
  }

  private acceptedCertification(): BackupTargetAdapterCertification | null {
    if (!this.certification || !this.expectedBinding
        || this.certification.adapter !== "browser_directory"
        || !artifactBindingEquals(this.certification.binding, this.expectedBinding)) return null;
    const observedAt = this.clock();
    if (observedAt < this.certification.issuedAt || observedAt >= this.certification.expiresAt)
      return null;
    return this.certification;
  }

  availability(): BackupAdapterAvailability {
    if (typeof this.environment.showDirectoryPicker !== "function")
      return { status: "unavailable", reasonCode: "unsupported_api" };
    if (typeof this.environment.createExclusiveFile !== "function")
      return { status: "unavailable", reasonCode: "unsupported_api" };
    if (!this.environment.secureContext)
      return { status: "unavailable", reasonCode: "insecure_context" };
    if (!this.environment.topLevelContext)
      return { status: "unavailable", reasonCode: "not_top_level" };
    if (!this.acceptedCertification())
      return { status: "unavailable", reasonCode: "adapter_uncertified" };
    return { status: "available" };
  }

  async authorizeFromUserGesture(appInstanceIdInput: string): Promise<BackupTargetAuthorization> {
    const availability = this.availability();
    if (availability.status === "unavailable") return availability;
    if (!this.environment.hasTransientUserActivation())
      return { status: "unavailable", reasonCode: "gesture_required" };

    let handle: BrowserDirectoryHandle;
    try {
      handle = await this.environment.showDirectoryPicker!();
    } catch (error) {
      const reason = mapIoFailure(error).reasonCode;
      return {
        status: "unavailable",
        reasonCode: reason === "permission_required" || reason === "operation_interrupted"
          ? reason : "target_unreachable",
      };
    }
    if (!isDirectoryHandle(handle))
      return { status: "unavailable", reasonCode: "target_unreachable" };
    if (!(await requestReadWritePermissionFromGesture(handle)))
      return { status: "unavailable", reasonCode: "permission_required" };

    const certification = this.acceptedCertification();
    const targetResult = BackupTargetV1.safeParse({
      schema: 1,
      targetId: this.createTargetId(),
      appInstanceId: appInstanceIdInput,
      adapter: "browser_directory",
      adapterCertificationId: certification?.certificationId,
      authorizedAt: this.clock(),
    });
    if (!targetResult.success)
      return { status: "unavailable", reasonCode: "adapter_uncertified" };
    try {
      await this.handleStore.save(targetResult.data.targetId, handle);
    } catch {
      return { status: "unavailable", reasonCode: "target_unreachable" };
    }
    return { status: "authorized", target: targetResult.data };
  }

  async probe(targetInput: BackupTarget): Promise<BackupTargetAuthorization> {
    const availability = this.availability();
    if (availability.status === "unavailable") return availability;
    const targetResult = BackupTargetV1.safeParse(targetInput);
    const certification = this.acceptedCertification();
    if (!targetResult.success || !certification
        || targetResult.data.adapterCertificationId !== certification.certificationId)
      return { status: "unavailable", reasonCode: "adapter_uncertified" };
    let handle: BrowserDirectoryHandle | null;
    try {
      handle = await this.handleStore.load(targetResult.data.targetId);
    } catch {
      return { status: "unavailable", reasonCode: "target_unreachable" };
    }
    if (!isDirectoryHandle(handle))
      return { status: "unavailable", reasonCode: "target_unconfigured" };
    try {
      await requireReadWritePermission(handle);
    } catch (error) {
      const reasonCode = mapIoFailure(error).reasonCode;
      return {
        status: "unavailable",
        reasonCode: reasonCode === "permission_required"
          ? "permission_required" : "target_unreachable",
      };
    }
    return { status: "authorized", target: targetResult.data };
  }

  async reauthorizeFromUserGesture(targetInput: BackupTarget): Promise<BackupTargetAuthorization> {
    const availability = this.availability();
    if (availability.status === "unavailable") return availability;
    if (!this.environment.hasTransientUserActivation())
      return { status: "unavailable", reasonCode: "gesture_required" };
    const targetResult = BackupTargetV1.safeParse(targetInput);
    const certification = this.acceptedCertification();
    if (!targetResult.success || !certification
        || targetResult.data.adapterCertificationId !== certification.certificationId)
      return { status: "unavailable", reasonCode: "adapter_uncertified" };

    let handle: BrowserDirectoryHandle | null;
    try {
      handle = await this.handleStore.load(targetResult.data.targetId);
    } catch {
      return { status: "unavailable", reasonCode: "target_unreachable" };
    }
    if (!isDirectoryHandle(handle))
      return { status: "unavailable", reasonCode: "target_unconfigured" };
    if (!(await requestReadWritePermissionFromGesture(handle)))
      return { status: "unavailable", reasonCode: "permission_required" };
    try {
      await this.handleStore.save(targetResult.data.targetId, handle);
    } catch {
      return { status: "unavailable", reasonCode: "target_unreachable" };
    }
    return { status: "authorized", target: targetResult.data };
  }

  directory(targetInput: BackupTarget): BrowserBackupDirectory {
    const targetResult = BackupTargetV1.safeParse(targetInput);
    if (!targetResult.success) throw new BackupDirectoryIoError("target_unconfigured");
    return new TargetDirectory(this, targetResult.data, this.environment.createExclusiveFile);
  }

  async reacquire(target: BackupTarget): Promise<BrowserDirectoryHandle> {
    const availability = this.availability();
    if (availability.status === "unavailable") {
      const reason = availability.reasonCode === "unsupported_api"
        ? "unsupported_api" : "adapter_uncertified";
      throw new BackupDirectoryIoError(reason);
    }
    const certification = this.acceptedCertification();
    if (!certification || target.adapterCertificationId !== certification.certificationId)
      throw new BackupDirectoryIoError("adapter_uncertified");
    if (!BackupTargetId.safeParse(target.targetId).success)
      throw new BackupDirectoryIoError("target_unconfigured");
    let handle: BrowserDirectoryHandle | null;
    try {
      handle = await this.handleStore.load(target.targetId);
    } catch (error) {
      throw mapIoFailure(error);
    }
    if (!isDirectoryHandle(handle))
      throw new BackupDirectoryIoError(handle === null ? "target_unconfigured" : "target_unreachable");
    return handle;
  }
}

const HANDLE_DB = "clay-device-handles-v1";
const HANDLE_STORE = "backup-directory-handles";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("device handle store request failed"));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(
      transaction.error ?? new Error("device handle store transaction failed"),
    );
    transaction.onabort = () => reject(
      transaction.error ?? new Error("device handle store transaction aborted"),
    );
  });
}

/** Concrete structured-clone store; handles are never encoded as JSON/localStorage. */
export class IndexedDbDirectoryHandleStore implements DirectoryHandleStore {
  constructor(private readonly factory: IDBFactory) {}

  private async database(): Promise<IDBDatabase> {
    const request = this.factory.open(HANDLE_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(HANDLE_STORE))
        request.result.createObjectStore(HANDLE_STORE);
    };
    return requestResult(request);
  }

  async load(targetId: string): Promise<BrowserDirectoryHandle | null> {
    const parsed = BackupTargetId.parse(targetId);
    const database = await this.database();
    try {
      const transaction = database.transaction(HANDLE_STORE, "readonly");
      const request = transaction.objectStore(HANDLE_STORE).get(parsed);
      const [result] = await Promise.all([
        requestResult(request) as Promise<unknown>,
        transactionComplete(transaction),
      ]);
      return isDirectoryHandle(result) ? result : null;
    } finally {
      database.close();
    }
  }

  async save(targetId: string, handle: BrowserDirectoryHandle): Promise<void> {
    const parsed = BackupTargetId.parse(targetId);
    if (!isDirectoryHandle(handle)) throw new Error("invalid browser directory handle");
    const database = await this.database();
    try {
      const transaction = database.transaction(HANDLE_STORE, "readwrite");
      const request = transaction.objectStore(HANDLE_STORE).put(handle, parsed);
      await Promise.all([requestResult(request), transactionComplete(transaction)]);
    } finally {
      database.close();
    }
  }

  async remove(targetId: string): Promise<void> {
    const parsed = BackupTargetId.parse(targetId);
    const database = await this.database();
    try {
      const transaction = database.transaction(HANDLE_STORE, "readwrite");
      const request = transaction.objectStore(HANDLE_STORE).delete(parsed);
      await Promise.all([requestResult(request), transactionComplete(transaction)]);
    } finally {
      database.close();
    }
  }
}
