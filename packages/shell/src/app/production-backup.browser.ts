import {
  BackupResultV1,
  BackupTargetV1,
  MAX_BACKUP_ARCHIVE_BYTES,
  runExternalBackup,
  type BackupPublicationReceipt,
  type BackupPublicationRequest,
  type BackupResult,
  type BackupRun,
  type BackupStageValidation,
  type BackupTarget,
  type BackupAdapterArtifactBinding,
  type BackupTargetAdapterCertification,
} from "@clay/kernel/backup";
import type { ProductionBackupSelection } from "@clay/kernel/worker-authority";
import type { WorkerClient } from "./worker-client";
import {
  ChromiumBackupDirectoryAdapter,
  IndexedDbDirectoryHandleStore,
  chromiumBackupEnvironmentFromGlobals,
  type BackupAdapterAvailability,
} from "./backup-target.browser";

export { MAX_BACKUP_ARCHIVE_BYTES };

const TARGET_STORAGE_PREFIX = "clay_backup_target_v1:";
const APP_ID = /^app_[a-z2-7]{26}$/;

const PRODUCTION_BACKUP_BINDING: BackupAdapterArtifactBinding = {
  implementationId: "clay.browser-directory",
  implementationVersion: "1.0.0",
  codeSha256: "sha256:6b6832f14b5c1b932424b082f67d7a0771fb86ec9fc1d34bb64fa272019d8fc1",
  releaseId: "rel_tzopy3g7hsheg2lxeesg2qty7x",
  buildSha256: "sha256:b60c8d5bf8ade6dd9c07c9fbdb4413b71cb5d6ee24dd622fd92a3ae09062cb08",
  runtime: {
    distribution: "managed_web",
    osFamily: "windows",
    osVersion: "10.0",
    runtimeFamily: "chromium",
    runtimeVersion: "149.0.7827.55",
    architecture: "x64",
  },
  matrixId: "browser-backup-matrix-v1",
  matrixSha256: "sha256:a2ba8662ef94977b78505c56891743cda7ed627383a9879ef8fadc90fab550df",
  suiteId: "browser-backup-suite-v1",
  suiteSha256: "sha256:e939baa0cabe1d91c94e0e6257b9388efca675feb2eb85a6d6da7c35ca68d256",
};

const PRODUCTION_BACKUP_CERTIFICATION: BackupTargetAdapterCertification = {
  schema: 1,
  certificationId: "btc_4w6xbvamg5bdmccgp5kwlwg4pi",
  binding: PRODUCTION_BACKUP_BINDING,
  adapter: "browser_directory",
  issuedAt: "2026-09-08T12:00:00.000Z",
  expiresAt: "2027-09-08T12:00:00.000Z",
  verdict: "pass",
  restartProbe: {
    probeId: "probe_4fjcdw45bopokwab74ffwbygud",
    firstProcessWriteSha256:
      "sha256:5c5c67fe433ca2c8a9008e905d1f092098573f3b28257dcd7fbe26ac3e3b0e48",
    fullProcessExitObserved: true,
    freshProcessReacquiredWithoutPicker: true,
    permissionRechecked: true,
    firstFileReadBackSha256:
      "sha256:5c5c67fe433ca2c8a9008e905d1f092098573f3b28257dcd7fbe26ac3e3b0e48",
    secondUniqueFileReadBackSha256:
      "sha256:dcacc1c325e73a67b38405997345f18e77077abf9c2181da8f535ad103d776ce",
    enumerationObservedBoth: true,
    ownedProbeCleanupVerified: true,
    evidenceSha256:
      "sha256:52e7761cd7d8c4126d21f7b801d5d502b28f8ec8ad84213a2a140fdcd1705102",
  },
};

export type ProductionBrowserRuntimeEvidence = Readonly<{
  userAgent: string;
  userAgentData: Readonly<{
    platform: string;
    mobile: boolean;
    brands: readonly Readonly<{ brand: string; version: string }>[];
  }> | null;
}>;

function productionBrowserRuntimeEvidenceFromGlobals(): ProductionBrowserRuntimeEvidence {
  const navigatorValue = Reflect.get(globalThis, "navigator");
  if (!navigatorValue || typeof navigatorValue !== "object")
    return { userAgent: "", userAgentData: null };
  const userAgentValue = Reflect.get(navigatorValue, "userAgent");
  const userAgentDataValue = Reflect.get(navigatorValue, "userAgentData");
  if (!userAgentDataValue || typeof userAgentDataValue !== "object")
    return { userAgent: typeof userAgentValue === "string" ? userAgentValue : "", userAgentData: null };
  const brandsValue = Reflect.get(userAgentDataValue, "brands");
  const platformValue = Reflect.get(userAgentDataValue, "platform");
  const mobileValue = Reflect.get(userAgentDataValue, "mobile");
  if (!Array.isArray(brandsValue) || brandsValue.length < 1 || brandsValue.length > 16
      || typeof platformValue !== "string" || typeof mobileValue !== "boolean")
    return { userAgent: typeof userAgentValue === "string" ? userAgentValue : "", userAgentData: null };
  const brands: Array<{ brand: string; version: string }> = [];
  for (let index = 0; index < brandsValue.length; index++) {
    const entry: unknown = brandsValue[index];
    if (!entry || typeof entry !== "object") return { userAgent: "", userAgentData: null };
    const brand = Reflect.get(entry, "brand");
    const version = Reflect.get(entry, "version");
    if (typeof brand !== "string" || typeof version !== "string")
      return { userAgent: "", userAgentData: null };
    brands.push({ brand, version });
  }
  return {
    userAgent: typeof userAgentValue === "string" ? userAgentValue : "",
    userAgentData: { platform: platformValue, mobile: mobileValue, brands },
  };
}

function parseProductionBrowserRuntimeEvidence(
  input: unknown,
): ProductionBrowserRuntimeEvidence | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  try {
    const userAgent = Reflect.get(input, "userAgent");
    const userAgentData = Reflect.get(input, "userAgentData");
    if (typeof userAgent !== "string" || !userAgentData || typeof userAgentData !== "object"
        || Array.isArray(userAgentData)) return null;
    const platform = Reflect.get(userAgentData, "platform");
    const mobile = Reflect.get(userAgentData, "mobile");
    const brandsValue = Reflect.get(userAgentData, "brands");
    if (platform !== "Windows" || mobile !== false || !Array.isArray(brandsValue)
        || brandsValue.length < 2 || brandsValue.length > 16) return null;
    const brands: Array<{ brand: string; version: string }> = [];
    for (let index = 0; index < brandsValue.length; index++) {
      const entry: unknown = brandsValue[index];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const brand = Reflect.get(entry, "brand");
      const version = Reflect.get(entry, "version");
      if (typeof brand !== "string" || brand.length < 1 || brand.length > 64
          || typeof version !== "string" || !/^[0-9]{1,3}$/.test(version)) return null;
      brands.push({ brand, version });
    }
    return { userAgent, userAgentData: { platform, mobile, brands } };
  } catch {
    return null;
  }
}

function isCertifiedProductionRuntime(input: unknown): boolean {
  const runtime = parseProductionBrowserRuntimeEvidence(input);
  if (!runtime?.userAgentData) return false;
  const brands = runtime.userAgentData.brands;
  const chromium = brands.some(entry => entry.brand === "Chromium" && entry.version === "149");
  const product = brands.some(entry =>
    (entry.brand === "Google Chrome" || entry.brand === "HeadlessChrome")
      && entry.version === "149");
  const forbiddenProduct = brands.some(entry =>
    /(?:Edge|Edg|Opera|OPR|Brave|Samsung)/i.test(entry.brand));
  return runtime.userAgentData.platform === "Windows"
    && runtime.userAgentData.mobile === false
    && chromium
    && product
    && !forbiddenProduct
    && /Windows NT 10\.0/.test(runtime.userAgent)
    && /(?:Win64|x64)/.test(runtime.userAgent)
    && /(?:Headless)?Chrome\/149\.0\.7827\.55(?:\s|$)/.test(runtime.userAgent)
    && !/(?:Edg|OPR|SamsungBrowser)\//.test(runtime.userAgent)
    && typeof Reflect.get(ArrayBuffer.prototype, "transfer") === "function";
}

export type ProductionBackupTargetState = Readonly<{
  target: BackupTarget;
  folderName: string;
}>;

export interface ProductionBackupTargetStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function mintTargetId(): string {
  if (!globalThis.crypto?.getRandomValues)
    throw new Error("secure backup target identity generation is unavailable");
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(17));
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let encoded = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && encoded.length < 26) {
      bits -= 5;
      encoded += alphabet[(value >>> bits) & 31]!;
      value &= (1 << bits) - 1;
    }
  }
  const targetId = `tgt_${encoded}`;
  if (!/^tgt_[a-z2-7]{26}$/.test(targetId))
    throw new Error("secure backup target identity generation failed");
  return targetId;
}

/**
 * Build the release-bound production directory adapter. The checked-in
 * certification is accepted only on its exact certified Chromium/Windows
 * runtime family; other builds and runtimes stay fail-closed.
 */
export function createProductionBackupAdapter(
  factory: IDBFactory | undefined = globalThis.indexedDB,
  environment = chromiumBackupEnvironmentFromGlobals(),
  runtimeEvidence: unknown = productionBrowserRuntimeEvidenceFromGlobals(),
  now: () => string = () => new Date().toISOString(),
): ChromiumBackupDirectoryAdapter | null {
  if (!factory) return null;
  const certified = isCertifiedProductionRuntime(runtimeEvidence);
  return new ChromiumBackupDirectoryAdapter({
    environment,
    handleStore: new IndexedDbDirectoryHandleStore(factory),
    certification: certified ? PRODUCTION_BACKUP_CERTIFICATION : null,
    expectedBinding: certified ? PRODUCTION_BACKUP_BINDING : null,
    createTargetId: mintTargetId,
    now,
  });
}

function targetStorageKey(appInstanceId: string): string | null {
  return APP_ID.test(appInstanceId) ? `${TARGET_STORAGE_PREFIX}${appInstanceId}` : null;
}

export function saveProductionBackupTarget(
  storage: ProductionBackupTargetStorage,
  state: ProductionBackupTargetState,
): void {
  const target = BackupTargetV1.parse(state.target);
  const folderName = state.folderName;
  if (typeof folderName !== "string" || folderName !== folderName.trim()
      || folderName.length < 1 || folderName.length > 255
      || /[\u0000-\u001f\u007f]/.test(folderName))
    throw new Error("backup folder name is invalid");
  storage.setItem(`${TARGET_STORAGE_PREFIX}${target.appInstanceId}`, JSON.stringify({
    target,
    folderName,
  }));
}

export function loadProductionBackupTarget(
  storage: ProductionBackupTargetStorage,
  appInstanceId: string,
): ProductionBackupTargetState | null {
  const key = targetStorageKey(appInstanceId);
  if (!key) return null;
  try {
    const encoded = storage.getItem(key);
    if (encoded === null || encoded.length > 4_096) return null;
    const value: unknown = JSON.parse(encoded);
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 2
        || !Object.hasOwn(record, "target") || !Object.hasOwn(record, "folderName")) return null;
    const target = BackupTargetV1.safeParse(record.target);
    if (!target.success || target.data.appInstanceId !== appInstanceId
        || typeof record.folderName !== "string"
        || record.folderName !== record.folderName.trim()
        || record.folderName.length < 1 || record.folderName.length > 255
        || /[\u0000-\u001f\u007f]/.test(record.folderName)) return null;
    return Object.freeze({
      target: Object.freeze({ ...target.data }),
      folderName: record.folderName,
    });
  } catch {
    return null;
  }
}

export type ProductionBackupWorker = Pick<
  WorkerClient,
  | "backupSelection"
  | "prepareAutomaticBackup"
  | "validateBackupStage"
  | "publishBackup"
  | "completeAutomaticBackup"
>;

export type ProductionBackupAdapter = Pick<
  ChromiumBackupDirectoryAdapter,
  "availability" | "directory"
>;

function unavailableResult(
  availability: Extract<BackupAdapterAvailability, { status: "unavailable" }>,
): BackupResult {
  const reasonCode = availability.reasonCode === "unsupported_api"
    ? "unsupported_api"
    : "adapter_uncertified";
  return BackupResultV1.parse({
    schema: 1,
    status: "failed",
    reasonCode,
    historical: null,
  });
}

/**
 * Main-thread half of automatic backup. The trusted worker snapshots and
 * authenticates the archive; this function owns only the certified directory
 * capability and feeds exact read-back bytes to the worker before publication.
 */
export async function runProductionAutomaticBackup(
  worker: ProductionBackupWorker,
  adapter: ProductionBackupAdapter,
  target: BackupTarget,
  reason: BackupRun["reason"],
  now: () => string = () => new Date().toISOString(),
): Promise<BackupResult> {
  const availability = adapter.availability();
  if (availability.status === "unavailable") return unavailableResult(availability);

  // Resolve the bounded directory capability before reserving a trust
  // generation. A malformed target therefore cannot strand a reservation.
  const directory = adapter.directory(target);
  const prepared = await worker.prepareAutomaticBackup(target, reason);
  if (!(prepared.bytes instanceof ArrayBuffer) || prepared.bytes.byteLength === 0)
    return BackupResultV1.parse({
      schema: 1,
      status: "failed",
      reasonCode: "snapshot_mismatch",
      historical: null,
    });

  const archiveBytes = new Uint8Array(prepared.bytes);
  try {
    const result = await runExternalBackup(prepared.run, archiveBytes, {
      directory,
      authority: {
        readSelectedTarget: async (): Promise<ProductionBackupSelection["selected"]> =>
          structuredClone((await worker.backupSelection()).selected),
        publish: async (
          request: BackupPublicationRequest,
        ): Promise<BackupPublicationReceipt> => worker.publishBackup(request),
      },
      validateArchiveStage: async (
        bytes: Uint8Array,
        expected,
      ): Promise<BackupStageValidation> => {
        const transfer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? bytes.buffer as ArrayBuffer : bytes.slice().buffer;
        return worker.validateBackupStage(transfer, expected);
      },
      now,
      archiveBytesOwnership: "transferred",
    });
    await worker.completeAutomaticBackup(result);
    return result;
  } finally {
    if (archiveBytes.byteLength > 0) archiveBytes.fill(0);
  }
}
