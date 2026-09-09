import { describe, expect, it } from "vitest";
import type {
  BackupAdapterArtifactBinding,
  BackupTarget,
  BackupTargetAdapterCertification,
} from "@clay/kernel/backup";
import {
  ChromiumBackupDirectoryAdapter,
  createChromiumExclusiveFileCreator,
  type BrowserDirectoryHandle,
  type BrowserFileHandle,
  type BrowserWritableFileStream,
  type ChromiumBackupEnvironment,
  type DirectoryHandleStore,
} from "../src/app/backup-target.browser";

const id = (prefix: string, char: string): string => `${prefix}_${char.repeat(26)}`;
const sha = (char: string): string => `sha256:${char.repeat(64)}`;
const targetId = id("tgt", "a");
const appInstanceId = id("app", "d");
const certificationId = id("btc", "b");
const now = "2026-09-05T21:00:00.000Z";
const expectedBinding: BackupAdapterArtifactBinding = {
  implementationId: "clay.browser-directory",
  implementationVersion: "1.0.0",
  codeSha256: sha("1"),
  releaseId: id("rel", "r"),
  buildSha256: sha("2"),
  runtime: {
    distribution: "managed_web",
    osFamily: "windows",
    osVersion: "11.0.0",
    runtimeFamily: "chromium",
    runtimeVersion: "149.0.7827.55",
    architecture: "x64",
  },
  matrixId: "browser-backup-matrix-v1",
  matrixSha256: sha("3"),
  suiteId: "browser-backup-suite-v1",
  suiteSha256: sha("4"),
};
const certification: BackupTargetAdapterCertification = {
  schema: 1,
  certificationId,
  binding: expectedBinding,
  adapter: "browser_directory",
  issuedAt: "2026-09-05T19:00:00.000Z",
  expiresAt: "2026-10-05T19:00:00.000Z",
  verdict: "pass",
  restartProbe: {
    probeId: id("probe", "p"),
    firstProcessWriteSha256: sha("5"),
    fullProcessExitObserved: true,
    freshProcessReacquiredWithoutPicker: true,
    permissionRechecked: true,
    firstFileReadBackSha256: sha("5"),
    secondUniqueFileReadBackSha256: sha("6"),
    enumerationObservedBoth: true,
    ownedProbeCleanupVerified: true,
    evidenceSha256: sha("7"),
  },
};
const fileName = "clay-field-ops-20260905T210000000Z-backupgen_cccccccccccccccccccccccccc.clay";

class MemoryHandleStore implements DirectoryHandleStore {
  readonly handles = new Map<string, BrowserDirectoryHandle>();

  async load(idValue: string): Promise<BrowserDirectoryHandle | null> {
    return this.handles.get(idValue) ?? null;
  }

  async save(idValue: string, handle: BrowserDirectoryHandle): Promise<void> {
    this.handles.set(idValue, handle);
  }

  async remove(idValue: string): Promise<void> {
    this.handles.delete(idValue);
  }
}

class FakeWritable implements BrowserWritableFileStream {
  #closed = false;

  constructor(
    private readonly directory: FakeDirectory,
    private readonly name: string,
  ) {}

  async write(data: Uint8Array): Promise<void> {
    if (this.#closed) throw new DOMException("closed", "InvalidStateError");
    this.directory.events.push(`native-write:${data.byteLength}`);
    if (this.directory.writeFailureName)
      throw new DOMException("injected write failure", this.directory.writeFailureName);
    this.directory.files.set(this.name, data.slice());
  }

  async close(): Promise<void> {
    if (this.#closed) throw new DOMException("closed", "InvalidStateError");
    this.#closed = true;
    this.directory.events.push("native-close");
  }
}

class FakeFileHandle implements BrowserFileHandle {
  readonly kind = "file" as const;

  constructor(
    private readonly directory: FakeDirectory,
    readonly name: string,
  ) {}

  async createWritable(): Promise<BrowserWritableFileStream> {
    this.directory.events.push("native-create-writable");
    return new FakeWritable(this.directory, this.name);
  }

  async getFile(): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> }> {
    this.directory.events.push("native-get-file");
    const bytes = this.directory.files.get(this.name);
    if (!bytes) throw new DOMException("missing", "NotFoundError");
    const copy = bytes.slice();
    return {
      size: copy.byteLength,
      arrayBuffer: async () => {
        this.directory.events.push("native-array-buffer");
        return copy.buffer.slice(
          copy.byteOffset,
          copy.byteOffset + copy.byteLength,
        ) as ArrayBuffer;
      },
    };
  }
}

class FakeDirectory implements BrowserDirectoryHandle {
  readonly kind = "directory" as const;
  readonly name = "Backups";
  readonly events: string[] = [];
  readonly files = new Map<string, Uint8Array>();
  readonly permissions: Array<"granted" | "prompt" | "denied"> = [];
  requestCalls = 0;
  writeFailureName: string | null = null;
  collisionOnCreate: Uint8Array | null = null;

  async queryPermission(descriptor: { mode: "readwrite" }): Promise<"granted" | "prompt" | "denied"> {
    expect(descriptor).toEqual({ mode: "readwrite" });
    this.events.push("query-readwrite");
    return this.permissions.shift() ?? "granted";
  }

  async requestPermission(descriptor: { mode: "readwrite" }): Promise<"granted" | "prompt" | "denied"> {
    expect(descriptor).toEqual({ mode: "readwrite" });
    this.requestCalls++;
    this.events.push("request-readwrite");
    return this.permissions.shift() ?? "granted";
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<BrowserFileHandle> {
    this.events.push(options?.create ? "native-create-file" : "native-open-file");
    if (!options?.create && !this.files.has(name))
      throw new DOMException("missing", "NotFoundError");
    if (options?.create && this.collisionOnCreate && !this.files.has(name)) {
      this.files.set(name, this.collisionOnCreate.slice());
      this.collisionOnCreate = null;
    }
    if (options?.create && !this.files.has(name)) this.files.set(name, new Uint8Array());
    return new FakeFileHandle(this, name);
  }

  async createExclusiveFile(name: string): Promise<BrowserFileHandle> {
    this.events.push("native-create-file-exclusive");
    if (this.collisionOnCreate && !this.files.has(name)) {
      this.files.set(name, this.collisionOnCreate.slice());
      this.collisionOnCreate = null;
    }
    if (this.files.has(name))
      throw new DOMException("already exists", "InvalidModificationError");
    this.files.set(name, new Uint8Array());
    return new FakeFileHandle(this, name);
  }

  async removeEntry(name: string): Promise<void> {
    this.events.push("native-remove-entry");
    if (!this.files.delete(name)) throw new DOMException("missing", "NotFoundError");
  }
}

function environment(
  directory: FakeDirectory,
  overrides: Partial<ChromiumBackupEnvironment> = {},
): ChromiumBackupEnvironment {
  return {
    secureContext: true,
    topLevelContext: true,
    hasTransientUserActivation: () => true,
    showDirectoryPicker: async () => directory,
    createExclusiveFile: async (handle, name) => {
      if (!(handle instanceof FakeDirectory))
        throw new DOMException("unsupported handle", "NotSupportedError");
      return handle.createExclusiveFile(name);
    },
    ...overrides,
  };
}

function target(): BackupTarget {
  return {
    schema: 1,
    targetId,
    appInstanceId,
    adapter: "browser_directory",
    adapterCertificationId: certificationId,
    authorizedAt: now,
  };
}

function adapter(
  directory: FakeDirectory,
  store: DirectoryHandleStore,
  overrides: Partial<ChromiumBackupEnvironment> = {},
  certificationInput: unknown = certification,
): ChromiumBackupDirectoryAdapter {
  return new ChromiumBackupDirectoryAdapter({
    environment: environment(directory, overrides),
    handleStore: store,
    certification: certificationInput,
    expectedBinding,
    createTargetId: () => targetId,
    now: () => now,
  });
}

describe("Chromium external-backup directory adapter", () => {
  it("feature-detects unsupported APIs without inventing automatic availability", async () => {
    const directory = new FakeDirectory();
    const store = new MemoryHandleStore();
    const subject = adapter(directory, store, { showDirectoryPicker: undefined });

    expect(subject.availability()).toEqual({
      status: "unavailable",
      reasonCode: "unsupported_api",
    });
    await expect(subject.authorizeFromUserGesture(appInstanceId)).resolves.toEqual({
      status: "unavailable",
      reasonCode: "unsupported_api",
    });
    expect(store.handles.size).toBe(0);
  });

  it("rejects missing, mismatched, or expired certification instead of self-certifying", async () => {
    const variants: unknown[] = [
      null,
      {
        ...certification,
        binding: { ...certification.binding, buildSha256: sha("9") },
      },
      {
        ...certification,
        expiresAt: "2026-09-05T20:00:00.000Z",
      },
      {
        ...certification,
        adapter: "native_directory",
      },
    ];
    for (const variant of variants) {
      const directory = new FakeDirectory();
      const store = new MemoryHandleStore();
      const subject = adapter(directory, store, {}, variant);
      expect(subject.availability()).toEqual({
        status: "unavailable",
        reasonCode: "adapter_uncertified",
      });
      await expect(subject.authorizeFromUserGesture(appInstanceId)).resolves.toEqual({
        status: "unavailable",
        reasonCode: "adapter_uncertified",
      });
      expect(store.handles.size).toBe(0);
    }
  });

  it("rejects a certified browser target when no atomic exclusive-create primitive exists", () => {
    const directory = new FakeDirectory();
    const store = new MemoryHandleStore();
    const withoutExclusiveCreate = {
      createExclusiveFile: undefined,
    } as Partial<ChromiumBackupEnvironment> & { readonly createExclusiveFile?: undefined };
    const subject = adapter(directory, store, withoutExclusiveCreate);

    expect(subject.availability()).toEqual({
      status: "unavailable",
      reasonCode: "unsupported_api",
    });
  });

  it("requires secure top-level transient activation before picker or permission request", async () => {
    for (const overrides of [
      { secureContext: false },
      { topLevelContext: false },
      { hasTransientUserActivation: () => false },
    ]) {
      const directory = new FakeDirectory();
      const store = new MemoryHandleStore();
      const subject = adapter(directory, store, overrides);
      await expect(subject.authorizeFromUserGesture(appInstanceId)).resolves.toMatchObject({
        status: "unavailable",
      });
      expect(directory.requestCalls).toBe(0);
      expect(store.handles.size).toBe(0);
    }
  });

  it("persists the structured-cloneable handle only after gesture authorization", async () => {
    const directory = new FakeDirectory();
    directory.permissions.push("prompt", "granted");
    const store = new MemoryHandleStore();
    const subject = adapter(directory, store);

    await expect(subject.authorizeFromUserGesture(appInstanceId)).resolves.toEqual({
      status: "authorized",
      target: target(),
    });
    expect(directory.events).toEqual(["query-readwrite", "request-readwrite"]);
    expect(store.handles.get(targetId)).toBe(directory);
  });

  it("rechecks a stored handle without prompting and downgrades revoked permission", async () => {
    const directory = new FakeDirectory();
    const store = new MemoryHandleStore();
    await store.save(targetId, directory);
    const subject = adapter(directory, store);
    directory.permissions.push("granted", "denied");
    await expect(subject.probe(target())).resolves.toEqual({
      status: "authorized",
      target: target(),
    });
    await expect(subject.probe(target())).resolves.toEqual({
      status: "unavailable",
      reasonCode: "permission_required",
    });
    expect(directory.requestCalls).toBe(0);
  });

  it("uses the production Web-Lock/exclusive-writer bridge without truncating a collision", async () => {
    const locks = {
      request: async <T>(
        _name: string,
        _options: { mode: "exclusive" },
        callback: () => Promise<T>,
      ): Promise<T> => callback(),
    };
    const directory = new FakeDirectory();
    const creator = createChromiumExclusiveFileCreator(locks);
    const reservation = await creator(directory, fileName);
    if (!("fileHandle" in reservation)) throw new Error("expected a held production reservation");
    await reservation.writable.write(new Uint8Array([1, 2, 3]));
    await reservation.writable.close();
    reservation.release();
    expect(directory.files.get(fileName)).toEqual(new Uint8Array([1, 2, 3]));

    const preserved = directory.files.get(fileName)!.slice();
    await expect(creator(directory, fileName)).rejects.toMatchObject({
      reasonCode: "destination_collision",
    });
    expect(directory.files.get(fileName)).toEqual(preserved);
  });

  it("keeps a denied folder choice unconfigured and reports only the closed reason", async () => {
    const directory = new FakeDirectory();
    directory.permissions.push("prompt", "denied");
    const store = new MemoryHandleStore();
    const subject = adapter(directory, store);

    await expect(subject.authorizeFromUserGesture(appInstanceId)).resolves.toEqual({
      status: "unavailable",
      reasonCode: "permission_required",
    });
    expect(directory.requestCalls).toBe(1);
    expect(directory.events).toEqual(["query-readwrite", "request-readwrite"]);
    expect(store.handles.size).toBe(0);
  });

  it("reports an interrupted folder picker without persisting a target", async () => {
    const directory = new FakeDirectory();
    const store = new MemoryHandleStore();
    const subject = adapter(directory, store, {
      showDirectoryPicker: async () => {
        throw new DOMException("selection canceled", "AbortError");
      },
    });

    await expect(subject.authorizeFromUserGesture(appInstanceId)).resolves.toEqual({
      status: "unavailable",
      reasonCode: "operation_interrupted",
    });
    expect(directory.requestCalls).toBe(0);
    expect(store.handles.size).toBe(0);
  });

  it("checks permission before an unattended exclusive collision check", async () => {
    const directory = new FakeDirectory();
    directory.files.set(fileName, new Uint8Array([7]));
    directory.permissions.push("prompt");
    const store = new MemoryHandleStore();
    await store.save(targetId, directory);
    const subject = adapter(directory, store);

    await expect(subject.directory(target()).createNew(fileName)).rejects.toMatchObject({
      reasonCode: "permission_required",
    });
    expect(directory.requestCalls).toBe(0);
    expect(directory.events).toEqual(["query-readwrite"]);
  });

  it("refuses a same-name file created between lookup and creation", async () => {
    const directory = new FakeDirectory();
    const collidingBytes = new Uint8Array([9, 8, 7]);
    directory.collisionOnCreate = collidingBytes;
    const store = new MemoryHandleStore();
    await store.save(targetId, directory);
    const subject = adapter(directory, store);

    await expect(subject.directory(target()).createNew(fileName)).rejects.toMatchObject({
      reasonCode: "destination_collision",
    });
    expect(directory.files.get(fileName)).toEqual(collidingBytes);
    expect(directory.events).not.toContain("native-create-writable");
  });

  it("never opens a permission prompt during any unattended scheduled operation", async () => {
    const assertNoPrompt = async (
      permissions: Array<"granted" | "prompt" | "denied">,
      action: (subject: ChromiumBackupDirectoryAdapter, directory: FakeDirectory) => Promise<unknown>,
      seedFile = false,
    ): Promise<void> => {
      const directory = new FakeDirectory();
      directory.permissions.push(...permissions);
      if (seedFile) directory.files.set(fileName, new Uint8Array([7]));
      const store = new MemoryHandleStore();
      await store.save(targetId, directory);
      const subject = adapter(directory, store);
      await expect(action(subject, directory)).rejects.toMatchObject({
        reasonCode: "permission_required",
      });
      expect(directory.requestCalls).toBe(0);
      expect(directory.events).not.toContain("request-readwrite");
    };

    await assertNoPrompt(["prompt"], subject =>
      subject.directory(target()).createNew(fileName));
    await assertNoPrompt(["granted", "prompt"], subject =>
      subject.directory(target()).createNew(fileName));
    await assertNoPrompt(["granted", "granted", "prompt"], async subject => {
      const writer = await subject.directory(target()).createNew(fileName);
      await writer.write(new Uint8Array([1]));
    });
    await assertNoPrompt(["granted", "granted", "granted", "prompt"], async subject => {
      const writer = await subject.directory(target()).createNew(fileName);
      await writer.write(new Uint8Array([1]));
      await writer.close();
    });
    await assertNoPrompt(["prompt"], subject =>
      subject.directory(target()).readExact(fileName), true);
    await assertNoPrompt(["prompt"], subject =>
      subject.directory(target()).removeExact(fileName), true);
  });

  it("queries readwrite permission immediately before every exclusive create and write", async () => {
    const directory = new FakeDirectory();
    const store = new MemoryHandleStore();
    await store.save(targetId, directory);
    const subject = adapter(directory, store);

    const writer = await subject.directory(target()).createNew(fileName);
    await writer.write(new Uint8Array([1, 2]));
    await writer.write(new Uint8Array([3]));
    await writer.close();

    expect(directory.events).toEqual([
      "query-readwrite", "native-create-file-exclusive",
      "query-readwrite", "native-create-writable",
      "query-readwrite", "native-write:2",
      "query-readwrite", "native-write:1",
      "query-readwrite", "native-close",
    ]);
  });

  it.each([
    [
      "opening the file snapshot",
      ["granted", "prompt"],
      ["query-readwrite", "native-open-file", "query-readwrite"],
    ],
    [
      "consuming the file bytes",
      ["granted", "granted", "denied"],
      [
        "query-readwrite", "native-open-file",
        "query-readwrite", "native-get-file",
        "query-readwrite",
      ],
    ],
  ] as const)("fails closed when permission is revoked before %s", async (
    _boundary, permissions, expectedEvents,
  ) => {
    const directory = new FakeDirectory();
    directory.files.set(fileName, new Uint8Array([7, 8, 9]));
    directory.permissions.push(...permissions);
    const store = new MemoryHandleStore();
    await store.save(targetId, directory);
    const subject = adapter(directory, store);

    await expect(subject.directory(target()).readExact(fileName)).rejects.toMatchObject({
      reasonCode: "permission_required",
    });
    expect(directory.requestCalls).toBe(0);
    expect(directory.events).toEqual(expectedEvents);
  });

  it("reacquires a persisted handle after adapter restart without another picker", async () => {
    const directory = new FakeDirectory();
    directory.files.set(fileName, new Uint8Array([7, 8, 9]));
    const store = new MemoryHandleStore();
    let pickerCalls = 0;
    const first = adapter(directory, store, {
      showDirectoryPicker: async () => {
        pickerCalls++;
        return directory;
      },
    });
    await first.authorizeFromUserGesture(appInstanceId);
    directory.events.length = 0;

    const restarted = adapter(directory, store, {
      showDirectoryPicker: async () => {
        pickerCalls++;
        return directory;
      },
    });
    await expect(restarted.directory(target()).readExact(fileName))
      .resolves.toEqual(new Uint8Array([7, 8, 9]));
    expect(pickerCalls).toBe(1);
    expect(directory.events).toEqual([
      "query-readwrite", "native-open-file",
      "query-readwrite", "native-get-file",
      "query-readwrite", "native-array-buffer",
    ]);
  });

  it("allows requestPermission only through explicit gesture reauthorization", async () => {
    const directory = new FakeDirectory();
    directory.permissions.push("prompt", "granted");
    const store = new MemoryHandleStore();
    await store.save(targetId, directory);
    const subject = adapter(directory, store);

    await expect(subject.reauthorizeFromUserGesture(target())).resolves.toEqual({
      status: "authorized",
      target: target(),
    });
    expect(directory.requestCalls).toBe(1);
    expect(directory.events).toEqual(["query-readwrite", "request-readwrite"]);
  });

  it("stops a later write when its fresh permission query is no longer granted", async () => {
    const directory = new FakeDirectory();
    directory.permissions.push("granted", "granted", "granted", "prompt");
    const store = new MemoryHandleStore();
    await store.save(targetId, directory);
    const subject = adapter(directory, store);

    const writer = await subject.directory(target()).createNew(fileName);
    await writer.write(new Uint8Array([1, 2]));
    await expect(writer.write(new Uint8Array([3, 4]))).rejects.toMatchObject({
      reasonCode: "permission_required",
    });
    await writer.close();

    expect(directory.files.get(fileName)).toEqual(new Uint8Array([1, 2]));
    expect(directory.requestCalls).toBe(0);
    expect(directory.events.filter(event => event === "query-readwrite")).toHaveLength(5);
    expect(directory.events.filter(event => event.startsWith("native-write:"))).toEqual([
      "native-write:2",
    ]);
  });

  it("blocks close when permission is revoked at the commit boundary", async () => {
    const directory = new FakeDirectory();
    directory.permissions.push("granted", "granted", "granted", "denied");
    const store = new MemoryHandleStore();
    await store.save(targetId, directory);
    const subject = adapter(directory, store);

    const writer = await subject.directory(target()).createNew(fileName);
    await writer.write(new Uint8Array([1, 2, 3]));
    await expect(writer.close()).rejects.toMatchObject({ reasonCode: "permission_required" });

    expect(directory.requestCalls).toBe(0);
    expect(directory.events.filter(event => event === "query-readwrite")).toHaveLength(4);
    expect(directory.events).not.toContain("native-close");
  });

  it.each([
    ["quota exhaustion", "QuotaExceededError", "quota_exceeded"],
    ["write interruption", "AbortError", "operation_interrupted"],
  ] as const)("maps %s during a native write and preserves the prior file", async (
    _label, failureName, reasonCode,
  ) => {
    const directory = new FakeDirectory();
    const priorName = fileName.replace(/c{26}/, "d".repeat(26));
    const prior = new Uint8Array([9, 8, 7]);
    directory.files.set(priorName, prior.slice());
    directory.writeFailureName = failureName;
    const store = new MemoryHandleStore();
    await store.save(targetId, directory);
    const subject = adapter(directory, store);

    const writer = await subject.directory(target()).createNew(fileName);
    await expect(writer.write(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ reasonCode });
    await writer.close();

    expect(directory.files.get(priorName)).toEqual(prior);
    expect(directory.requestCalls).toBe(0);
  });

  it("blocks an exact rotation delete when permission was revoked", async () => {
    const directory = new FakeDirectory();
    const prior = new Uint8Array([9, 8, 7]);
    directory.files.set(fileName, prior.slice());
    directory.permissions.push("denied");
    const store = new MemoryHandleStore();
    await store.save(targetId, directory);
    const subject = adapter(directory, store);

    await expect(subject.directory(target()).removeExact(fileName)).rejects.toMatchObject({
      reasonCode: "permission_required",
    });
    expect(directory.requestCalls).toBe(0);
    expect(directory.files.get(fileName)).toEqual(prior);
    expect(directory.events).toEqual(["query-readwrite"]);
  });

  it("rejects an existing same-name file and caller path before any overwrite", async () => {
    const directory = new FakeDirectory();
    const existing = new Uint8Array([9, 8, 7]);
    directory.files.set(fileName, existing.slice());
    const store = new MemoryHandleStore();
    await store.save(targetId, directory);
    const subject = adapter(directory, store);
    const destination = subject.directory(target());

    await expect(destination.createNew(fileName)).rejects.toMatchObject({
      reasonCode: "destination_collision",
    });
    expect(directory.files.get(fileName)).toEqual(existing);
    expect(directory.events).toEqual(["query-readwrite", "native-create-file-exclusive"]);

    directory.events.length = 0;
    await expect(destination.createNew("../../outside.clay")).rejects.toMatchObject({
      reasonCode: "destination_collision",
    });
    expect(directory.events).toEqual([]);
  });
});
