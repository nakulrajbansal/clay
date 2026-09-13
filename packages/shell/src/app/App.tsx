// The shell chrome (doc 02 §1): onboarding -> main screen with panel
// regions + conversation rail. Live panels bind to the live store's Bridge;
// during S5 the proposed panels render in place with a dashed frame,
// bound to a SECOND Bridge over the shadow store (preview-before-commit).
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bridge, StoreRpcClient, deriveSafeDiffKind, portFromMessagePort }
  from "@clay/kernel/shell-runtime";
import type {
  BatchReceipt, ClayNotification, FieldProvenance, HistoryEntry,
  LivePanel, PanelProvenance, PrivateMetricEvent,
  PrivateMetricsSummary, RegTable, SemanticSchemaTraceV1, Suggestion,
} from "@clay/kernel";
import { targetIdentityEquals } from "@clay/kernel/protection";
import type { BackupRecord, BackupRun } from "@clay/kernel/backup";
import type {
  AuthenticatedFormat5RestoreGrant,
  BackupFailureReasonCode,
} from "@clay/kernel/recovery";
import { WorkerClient, type BootInfo, type RecoveryRecordCandidate } from "./worker-client";
import { getRelayOwnerUrl } from "../intake/relay-owner-configuration";
import { productionWorkerRouteAvailable } from "../worker/mutation-route-census";
import { beginAppSetup, readAppSetup, saveAppSetup, finishAppSetup } from "./app-setup-intent";
import { ManualDownloadRecovery, type ManualDownloadIntent } from "./manual-download-recovery";
import { runRetainedAutomationTick } from "./automation-tick";
import {
  LatestRequestGate, beginLazySession, createRetryingLoader, runLatestRequest,
} from "./async-lifecycle";
import type { BackupTrustRuntimeStatus } from "../worker/backup-trust-runtime";
import { fetchModelHealth } from "./model-health";
import {
  HostedAuthFence, advanceHostedAuthRevocation, captureHostedAuthLanding,
  commitHostedAuthAttempt, consumePersistedHostedAuthAttempt,
  logoutHostedBearerSession, logoutHostedSession, reconcileHostedAuthEpoch,
  redeemHostedAuthAttempt, observeHostedAccountChanges, publishHostedAccountChange,
  type HostedAuthAttempt,
} from "./account-auth";
import type {
  DeviceProtectionProjection, IntentOutcome, PreviewInfo,
} from "../worker/db-worker";
import type { StarterShellId } from "../shells/seed";
import { ConversationRail, pruneFeedAfterVersion, type FeedItem } from "./ConversationRail";
import {
  firstSuccessCount, loadFirstSuccessState, mutateFirstSuccessState,
  type FirstSuccessState, type ShellFirstSuccessEvent,
} from "./first-success-state";
import { openEverydayActionTarget } from "./everyday-action-navigation";
import { Onboarding } from "./Onboarding";
import { ImportReview, type ReviewedImportFile } from "./ImportReview";
import { TimeSlider } from "./TimeSlider";
import { AppSwitcher } from "./AppSwitcher";
import {
  currentApp, currentAppId, listApps, replaceAppCache, shellName, type AppEntry,
} from "./apps";
import {
  THEMES, applyThemeToRoot, getThemeId, panelThemeCss, setThemeId as saveThemeId, themeById,
} from "./themes";
import {
  getActiveModelAccess, getApiKey, getBackendUrl, getModelProvider,
  getSessionToken, hasModelAccess, isAmbientSessionAllowed, normalizeBackendUrl,
  setAmbientSessionAllowed, setApiKey, setBackendUrl, setModelProvider,
  setSessionToken, type ModelProviderId,
} from "./settings";
import { reorder, type Region } from "./layout";
import { buildTrustReceipt } from "./change-contract";
import { useLensController } from "./useLensController";
import { LazySurfaceBoundary } from "./LazySurfaceBoundary";
import { ModalDialog, ModalScopedPortal } from "./ModalDialog";
import type {
  RecoveryActionFailure,
  RecoveryBackupSummary,
  RecoveryRetentionWork,
  RecoveryFailureSummary,
} from "./RecoveryCenter";
import type {
  createProductionBackupAdapter,
  ProductionBackupTargetState,
} from "./production-backup.browser";
import type { AutomaticBackupTriggerController } from "./automatic-backup-trigger.browser";
import {
  readWorkspaceModeForEntry, useWorkspaceMode, type WorkspaceMode,
} from "./workspace-mode";

type Phase = "loading" | "onboarding" | "main" | "error";
type BackupAdapterStatus = "loading" | "available" | "unavailable" | "error";

const FirstSuccessChecklist = lazy(() => import("./FirstSuccessChecklist")
  .then(module => ({ default: module.FirstSuccessChecklist })));
const DataView = lazy(() => import("./DataView").then(module => ({ default: module.DataView })));
const TodayView = lazy(() => import("./TodayView").then(module => ({ default: module.TodayView })));
const CommandPalette = lazy(() => import("./CommandPalette")
  .then(module => ({ default: module.CommandPalette })));
const AutomationCenter = lazy(() => import("./AutomationCenter")
  .then(module => ({ default: module.AutomationCenter })));
const IntakeCenter = lazy(() => import("./IntakeCenter")
  .then(module => ({ default: module.IntakeCenter })));
const HistoryView = lazy(() => import("./HistoryView").then(module => ({ default: module.HistoryView })));
const PanelFrame = lazy(() => import("./PanelFrame").then(module => ({ default: module.PanelFrame })));
const ShapeMapView = lazy(() => import("./ShapeMapView").then(module => ({ default: module.ShapeMapView })));
const PrivateMetricsView = lazy(() => import("./PrivateMetricsView")
  .then(module => ({ default: module.PrivateMetricsView })));
const RecoveryCenter = lazy(() => import("./RecoveryCenter")
  .then(module => ({ default: module.RecoveryCenter })));

type ProductionBackupRuntime = typeof import("./production-backup.browser");
type ProductionBackupAdapter = ReturnType<typeof createProductionBackupAdapter>;
type AutomaticBackupRuntime = typeof import("./automatic-backup-trigger.browser");
const loadProductionBackupRuntime = createRetryingLoader<ProductionBackupRuntime>(
  () => import("./production-backup.browser"),
);
const loadAutomaticBackupTriggerRuntime = createRetryingLoader<AutomaticBackupRuntime>(
  () => import("./automatic-backup-trigger.browser"),
);

function SurfaceFallback({ label, modal = false }: {
  label: string; modal?: boolean;
}): React.JSX.Element {
  const status = <div className="surface-loading" role="status">Opening {label}…</div>;
  return modal ? <div className="surface-loading-backdrop">{status}</div> : status;
}

function durationBucket(ms: number): "under_3m" | "3_to_10m" | "10_to_30m" | "over_30m" {
  if (ms < 180_000) return "under_3m";
  if (ms < 600_000) return "3_to_10m";
  if (ms < 1_800_000) return "10_to_30m";
  return "over_30m";
}

export function firstSuccessJourneyComplete(
  state: FirstSuccessState | null,
  protection: DeviceProtectionProjection | null,
): boolean {
  return state !== null && firstSuccessCount(state) === 4
    && protection?.result.state === "protected_on_device"
    && protection.checkpoint.state === "valid"
    && targetIdentityEquals(protection.target, protection.checkpoint.target);
}

async function prepareWorkerModelAccess(
  access: ReturnType<typeof getActiveModelAccess>,
  claySession: string | null,
  allowAmbientCredentials = false,
): Promise<ReturnType<typeof getActiveModelAccess> & {
  session: string | null; providerToken?: string | null; allowAmbientCredentials: boolean;
  protectedSecrets: readonly string[];
}> {
  let providerToken: string | null = null;
  if (access.provider === "codex" && access.backendUrl) {
    try {
      const response = await fetchModelHealth(`${access.backendUrl.replace(/\/$/, "")}/healthz`);
      const health = response.value as {
        provider?: string; connector_token?: string;
      };
      if (response.ok && health.provider === "codex"
          && typeof health.connector_token === "string"
          && health.connector_token.length >= 32
          && health.connector_token.length <= 1_024) providerToken = health.connector_token;
    } catch { /* the status surface reports an unreachable connector */ }
  }
  const protectedSecrets = [
    getApiKey(), getSessionToken(getBackendUrl()), claySession, providerToken,
  ].filter((secret): secret is string => typeof secret === "string" && secret.length > 0);
  return {
    ...access,
    session: access.provider === "clay" ? claySession : null,
    allowAmbientCredentials: access.provider === "clay" && allowAmbientCredentials,
    protectedSecrets: Object.freeze([...new Set(protectedSecrets)]),
    ...(access.provider === "codex" ? { providerToken } : {}),
  };
}

/** Reject if a promise doesn't settle in time — turns a silent OPFS/worker
 * stall into a visible, recoverable error instead of an eternal spinner. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms)),
  ]);
}

const MAX_RECOVERY_KIT_BYTES = 16 * 1024;
const RECOVERY_FAILURE_PREFIX = "clay_recovery_failures_v1:";

function recoveryBackupSummaries(
  records: readonly BackupRecord[],
  appInstanceId: string,
  retention?: import("@clay/schema/backup").BackupRetentionHistoryV1,
): RecoveryBackupSummary[] {
  const attempts = new Map(retention?.events.map(event => [event.intent.backupId, event]));
  return records
    .filter(record => record.evidence.appInstanceId === appInstanceId
      && (record.state === "valid" || record.state === "deleted") && record.validationCode === "archive_valid")
    .sort((left, right) => right.validatedAt.localeCompare(left.validatedAt))
    .slice(0, 64)
    .map(record => ({
      backupId: record.backupId,
      fileName: record.fileName,
      verifiedAt: record.validatedAt,
      byteLength: record.byteLength,
      targetId: record.targetId,
      availability: record.state === "deleted" ? "absent" as const
        : attempts.get(record.backupId)?.outcome === "failed" ? "removal_failed" as const : "unconfirmed" as const,
      observedAt: attempts.get(record.backupId)?.completedAt,
    }));
}

function closedBackupFailureCode(reason: string): BackupFailureReasonCode {
  switch (reason) {
    case "unsupported_api":
    case "adapter_uncertified":
    case "permission_required":
    case "target_unreachable":
    case "operation_interrupted":
      return reason;
    default:
      return "adapter_uncertified";
  }
}

function recoveryActionCode(error: unknown): string {
  if (error && (typeof error === "object" || typeof error === "function")) {
    const code = Reflect.get(error, "code");
    if (typeof code === "string" && /^E_[A-Z0-9_]{1,63}$/.test(code)) return code;
  }
  return "E_RECOVERY_CONFLICT";
}

function loadRecoveryFailures(appInstanceId: string): RecoveryActionFailure[] {
  if (!/^app_[a-z2-7]{26}$/.test(appInstanceId)) return [];
  try {
    const encoded = localStorage.getItem(`${RECOVERY_FAILURE_PREFIX}${appInstanceId}`);
    if (encoded === null || encoded.length > 16_384) return [];
    const value: unknown = JSON.parse(encoded);
    if (!Array.isArray(value)) return [];
    return value.slice(0, 20).filter((entry): entry is RecoveryActionFailure =>
      !!entry && typeof entry === "object" && !Array.isArray(entry)
        && typeof Reflect.get(entry, "id") === "string"
        && typeof Reflect.get(entry, "at") === "string"
        && ["record", "batch", "structure"].includes(String(Reflect.get(entry, "action")))
        && /^E_[A-Z0-9_]{1,63}$/.test(String(Reflect.get(entry, "code"))));
  } catch { return []; }
}

async function boundedFileBytes(file: File, maximum: number, label: string): Promise<ArrayBuffer> {
  if (!(file instanceof File) || file.size < 1 || file.size > maximum)
    throw new Error(`${label} has an invalid size`);
  return file.arrayBuffer();
}

function startBrowserDownload(
  fileName: string,
  bytes: ArrayBuffer | Uint8Array,
  contentType: string,
): void {
  const payload = bytes instanceof Uint8Array ? bytes.slice().buffer as ArrayBuffer : bytes;
  const url = URL.createObjectURL(new Blob([payload], { type: contentType }));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

type Toast = { id: number; msg: string; kind: string;
  action?: { label: string; run: () => void } };

type PanelFault = { code: string; message: string };
type RecoveryMethod = "panel_repair" | "panel_revert" | "row_restore" | "history_rewind";

function privateFaultKind(code: string): "runtime" | "strike_limit" | "render_timeout" | "unknown" {
  if (/strike/i.test(code)) return "strike_limit";
  if (/timeout/i.test(code)) return "render_timeout";
  if (/runtime|panel/i.test(code)) return "runtime";
  return "unknown";
}

function makeBridge(client: WorkerClient, target: "live" | "shadow",
  onToast: (msg: string, kind: string) => void,
  onFault: (panelId: string, fault: PanelFault) => void,
  onConfirm: (msg: string) => Promise<boolean>,
  onOpenRecord?: (table: string, id: string) => void): Bridge {
  const port = client.openStorePort(target);
  const store = new StoreRpcClient(portFromMessagePort(port));
  return new Bridge(store, {
    onToast: (_panel, msg, kind) => onToast(msg, kind),
    onConfirm: async (_panel, msg) => onConfirm(msg),
    onOpenRecord: target === "live" && onOpenRecord
      ? (_panel, table, id) => onOpenRecord(table, id) : undefined,
    onPanelError: (panelId, code, message) => onFault(panelId, { code, message }),
    onBoundary: (panelId, reason) =>
      onFault(panelId, { code: "E_STRIKES", message: reason }),
    // live bridge only: feed the Observer's repeated-filter heuristic
    onEvent: target === "live"
      ? (_panel, name, payload) => {
          void client.recordFilter(name, payload, client.createMutationContext());
        }
      : undefined,
  }, { allowWrites: target === "live" });
}

export function App(): React.JSX.Element {
  const [authFence] = useState(() => new HostedAuthFence());
  const [authLanding, setAuthLanding] =
    useState<ReturnType<typeof captureHostedAuthLanding>>(null);
  const workerRef = useRef<WorkerClient | null>(null);
  const reloadScheduled = useRef(false);
  const appReadyAt = useRef(Date.now());
  const activationRecorded = useRef(false);
  const firstKeepAt = useRef<number | null>(null);
  const proofLoopRecorded = useRef(false);
  const pendingRecovery = useRef<RecoveryMethod | null>(null);
  const surfaceReturnFocus = useRef<HTMLElement | null>(null);
  const openRecordRef = useRef<(table: string, id: string) => void>(() => {});
  const restoreToRef = useRef<(version: number) => Promise<void>>(async () => {});
  const firstRunOnboarding = useRef(false);
  const firstRunTargetId = useRef<string | null>(null);
  const onboardingCreatesApp = useRef(false);
  const [phase, setPhase] = useState<Phase>("loading");
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [automationStorageAvailable, setAutomationStorageAvailable] = useState(false);
  const [automationWaitReason, setAutomationWaitReason] = useState<string | null>(null);
  const currentIdRef = useRef(currentId);
  const recoveryRefreshGate = useRef(new LatestRequestGate()).current;
  useLayoutEffect(() => {
    currentIdRef.current = currentId;
    recoveryRefreshGate.invalidate();
  }, [currentId, recoveryRefreshGate]);
  const [workspaceMode, setWorkspaceMode] = useWorkspaceMode(currentId);
  const [bootError, setBootError] = useState<string | null>(null);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<{
    fileName: string; displayName: string; parsed: ReviewedImportFile;
  } | null>(null);
  const [firstSuccess, setFirstSuccess] = useState<FirstSuccessState | null>(null);
  const [deviceProtectionState, setDeviceProtectionState] =
    useState<DeviceProtectionProjection | null>(null);
  const [firstSuccessLoading, setFirstSuccessLoading] = useState(false);
  const [firstSuccessError, setFirstSuccessError] = useState<string | null>(null);
  const [firstRunEvidence, setFirstRunEvidence] = useState({
    sampleCount: 0, sampleTables: [] as string[], realRecordCount: 0,
    provenanceValid: false,
  });
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ region: Region; index: number; col: number | null } | null>(null);
  const [themeId, setThemeId] = useState<string>(() => getThemeId(currentAppId()));
  const [intentSeed, setIntentSeed] = useState<{ text: string; n: number }>({ text: "", n: 0 });
  const seedIntent = (t: string): void => setIntentSeed(s => ({ text: t, n: s.n + 1 }));
  const [persistent, setPersistent] = useState(true);
  const [panels, setPanels] = useState<LivePanel[]>([]);
  const [panelProvenance, setPanelProvenance] = useState<PanelProvenance[]>([]);
  const [fieldProvenance, setFieldProvenance] = useState<FieldProvenance[]>([]);
  const [semanticTrace, setSemanticTrace] = useState<SemanticSchemaTraceV1 | null>(null);
  const [registryTables, setRegistryTables] = useState<RegTable[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [scrub, setScrub] = useState<{ version: number; panels: LivePanel[] } | null>(null);
  const [liveBridge, setLiveBridge] = useState<Bridge | null>(null);
  const [shadowBridge, setShadowBridge] = useState<Bridge | null>(null);
  const [preview, setPreview] = useState<PreviewInfo | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [modelProvider, setModelProviderState] = useState<ModelProviderId>(() => getModelProvider());
  const [faults, setFaults] = useState<Record<string, PanelFault>>({});
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showData, setShowData] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [quickCaptureMode, setQuickCaptureMode] = useState(false);
  const [dailyRefresh, setDailyRefresh] = useState(0);
  const invalidateDailyHome = useCallback((): void => {
    setDailyRefresh(value => value + 1);
  }, []);
  const [showAutomations, setShowAutomations] = useState(false);
  const [showIntake, setShowIntake] = useState(false);
  const [automationRecipe, setAutomationRecipe] = useState<"recurring_record" | undefined>();
  const [automationTargetId, setAutomationTargetId] = useState<string | undefined>();
  const [notifications, setNotifications] = useState<ClayNotification[]>([]);
  const notificationProjectionSignature = useRef("");
  const [dataTable, setDataTable] = useState<string | null>(null);
  const [dataRecord, setDataRecord] = useState<string | null>(null);
  const [dataSavedView, setDataSavedView] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showShapeMap, setShowShapeMap] = useState(false);
  const [showPrivateMetrics, setShowPrivateMetrics] = useState(false);
  const [showRecoveryCenter, setShowRecoveryCenter] = useState(false);
  const [backupTrustStatus, setBackupTrustStatus] =
    useState<BackupTrustRuntimeStatus | null>(null);
  const [importedVerifierSeriesId, setImportedVerifierSeriesId] =
    useState<string | null>(null);
  const [backupTarget, setBackupTarget] = useState<ProductionBackupTargetState | null>(null);
  const [backupTargetHint, setBackupTargetHint] =
    useState<ProductionBackupTargetState | null>(null);
  const [backupHistory, setBackupHistory] = useState<RecoveryBackupSummary[]>([]);
  const [backupRetentionWork, setBackupRetentionWork] = useState<RecoveryRetentionWork[]>([]);
  const [manualDownloads, setManualDownloads] = useState<import("@clay/schema/backup").ManualBackupDownloadV2[]>([]);
  const [pendingDownloadRecord, setPendingDownloadRecord] = useState<ManualDownloadIntent | null>(null);
  const downloadBusy = useRef(false);
  const [backupFailures, setBackupFailures] = useState<RecoveryFailureSummary[]>([]);
  const [recoveryBatches, setRecoveryBatches] = useState<BatchReceipt[]>([]);
  const [recoveryRecords, setRecoveryRecords] = useState<RecoveryRecordCandidate[]>([]);
  const [recoveryActionFailures, setRecoveryActionFailures] =
    useState<RecoveryActionFailure[]>([]);
  const backupFailureId = useRef(0);
  const recoveryFailureId = useRef(0);
  const componentActive = useRef(true);
  const automaticBackupLoadFailed = useRef(false);
  const automaticBackupRetryAttempts = useRef(0);
  const [automaticBackupLoadGeneration, setAutomaticBackupLoadGeneration] = useState(0);
  const backupAdapterRef = useRef<ProductionBackupAdapter | undefined>(undefined);
  const backupAdapterLoadRef = useRef<Promise<ProductionBackupAdapter> | null>(null);
  const [backupAdapterStatus, setBackupAdapterStatus] =
    useState<BackupAdapterStatus>("loading");
  const backupAdapterAvailable = backupAdapterStatus === "available";
  const ensureBackupAdapter = useCallback((): Promise<ProductionBackupAdapter> => {
    if (backupAdapterRef.current !== undefined)
      return Promise.resolve(backupAdapterRef.current);
    if (componentActive.current) setBackupAdapterStatus("loading");
    backupAdapterLoadRef.current ??= loadProductionBackupRuntime().then(runtime => {
      const adapter = runtime.createProductionBackupAdapter();
      backupAdapterRef.current = adapter;
      if (componentActive.current) setBackupAdapterStatus(
        adapter?.availability().status === "available" ? "available" : "unavailable",
      );
      return adapter;
    }).catch(error => {
      if (componentActive.current) setBackupAdapterStatus("error");
      throw error;
    }).finally(() => { backupAdapterLoadRef.current = null; });
    return backupAdapterLoadRef.current;
  }, []);
  const retryAutomaticBackupRuntime = useCallback((): void => {
    if (!automaticBackupLoadFailed.current) return;
    automaticBackupLoadFailed.current = false;
    setAutomaticBackupLoadGeneration(generation => generation + 1);
  }, []);
  useEffect(() => {
    componentActive.current = true;
    return () => {
      componentActive.current = false;
      recoveryRefreshGate.invalidate();
    };
  }, [recoveryRefreshGate]);
  useEffect(() => {
    if (phase !== "main") return;
    void ensureBackupAdapter().catch(() => undefined);
  }, [phase, ensureBackupAdapter]);
  const [privateMetricsSummary, setPrivateMetricsSummary] = useState<PrivateMetricsSummary | null>(null);
  const [railOpen, setRailOpen] = useState<boolean>(() => {
    try { return localStorage.getItem("clay_reshape_open") !== "false"; }
    catch { return true; }
  });
  const chooseWorkspaceMode = (mode: WorkspaceMode): void => {
    setWorkspaceMode(mode);
    if (mode !== "work") return;
    setRailOpen(false);
    setShowAutomations(false);
    setShowIntake(false);
    setShowData(false);
    setShowShapeMap(false);
    setShowPrivateMetrics(false);
  };
  const dataStoreRef = useRef<StoreRpcClient | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  useEffect(() => {
    const openSearch = (event: KeyboardEvent): void => {
      const activeModal = document.querySelector<HTMLElement>('[aria-modal="true"]');
      const paletteCanStack = !activeModal || activeModal.closest(".modal-backdrop") !== null;
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k"
          && phase === "main" && paletteCanStack) {
        event.preventDefault();
        setQuickCaptureMode(false);
        if (!dataStoreRef.current && workerRef.current) {
          dataStoreRef.current = new StoreRpcClient(
            portFromMessagePort(workerRef.current.openStorePort("live")));
        }
        setShowCommandPalette(open => !open);
      }
    };
    window.addEventListener("keydown", openSearch);
    return () => window.removeEventListener("keydown", openSearch);
  }, [phase]);

  const pushToast = useCallback((msg: string, kind: string,
    action?: { label: string; run: () => void }): void => {
    const id = ++toastId.current;
    setToasts(t => [...t, { id, msg, kind, action }]);
    // actionable toasts linger long enough to actually click
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), action ? 7000 : 3500);
  }, []);

  // Capture the no-cookie fragment handoff, then remove token/state from the
  // visible URL before any asynchronous boot or model work.
  useEffect(() => {
    try {
      const u = new URL(window.location.href);
      const landing = captureHostedAuthLanding(u.toString());
      const fragment = new URLSearchParams(u.hash.slice(1));
      if (landing) setAuthLanding(landing);
      else if (fragment.has("auth"))
        pushToast("That sign-in link is invalid or expired — request a fresh one", "danger");
      if (fragment.has("auth") || u.searchParams.has("auth")) {
        u.hash = "";
        u.searchParams.delete("auth");
        window.history.replaceState(null, "", u.toString());
      }
    } catch { /* non-browser context */ }
  }, [pushToast]);

  const client = (): WorkerClient => {
    if (!workerRef.current) throw new Error("worker not ready");
    return workerRef.current;
  };
  const mutationContext = () => client().createMutationContext();
  const firstSuccessSettings = (wc: WorkerClient) => ({
    getSetting: (key: string) => wc.getSetting(key),
    compareAndSetSetting: (key: string, expectedRevision: number, value: FirstSuccessState) =>
      wc.compareAndSetSetting(key, expectedRevision, value, wc.createMutationContext()),
  });

  const loadFirstSuccess = useCallback(async (wc: WorkerClient): Promise<void> => {
    setFirstSuccessLoading(true);
    setFirstSuccessError(null);
    try {
      setFirstSuccess(await loadFirstSuccessState(firstSuccessSettings(wc)));
    } catch {
      setFirstSuccess(null);
      setFirstSuccessError("Setup progress could not be loaded. Your records were not changed.");
    } finally {
      setFirstSuccessLoading(false);
    }
  }, []);

  const refreshDeviceProtection = useCallback(async (wc: WorkerClient): Promise<void> => {
    try { setDeviceProtectionState(await wc.deviceProtection()); }
    catch { setDeviceProtectionState(null); }
  }, []);

  const updateFirstSuccess = useCallback(async (
    event: ShellFirstSuccessEvent, wc: WorkerClient = client(),
  ): Promise<void> => {
    try {
      const next = await mutateFirstSuccessState(firstSuccessSettings(wc), event);
      setFirstSuccess(next);
      setFirstSuccessError(null);
      await refreshDeviceProtection(wc);
    } catch {
      setFirstSuccessError("Setup progress could not be saved. Your records were not changed.");
    }
  }, [refreshDeviceProtection]);

  const refreshFirstRunEvidence = useCallback(async (wc: WorkerClient): Promise<void> => {
    const evidence = await wc.firstRunEvidence();
    setFirstRunEvidence(evidence);
    if (evidence.provenanceValid && evidence.realRecordCount > 0 && await wc.mayRecordPresentationSideEffects()) {
      await updateFirstSuccess({
        type: "real_record", source: "create", changed: evidence.realRecordCount, sample: false,
      }, wc);
    }
  }, [updateFirstSuccess]);

  // Until the first real record is observed, poll only content-free worker
  // evidence. Exact sample row ids remain inside the worker boundary.
  useEffect(() => {
    if (phase !== "main" || !workerRef.current
        || firstSuccess?.start.state !== "complete"
        || firstSuccess.steps.realRecord.state === "complete") return;
    const wc = workerRef.current;
    let live = true;
    const check = (): void => {
      void refreshFirstRunEvidence(wc).catch(() => {
        if (live) setFirstSuccessError(
          "Setup progress could not be checked. Your records were not changed.",
        );
      });
    };
    check();
    const timer = window.setInterval(check, 4_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [phase, firstSuccess, refreshFirstRunEvidence]);

  useEffect(() => {
    if (phase !== "main" || !workerRef.current || !currentId) return;
    const worker = workerRef.current; const app = currentId;
    setAutomationStorageAvailable(false); setAutomationWaitReason(null);
    let live = true;
    let running = false;
    const tick = async (): Promise<void> => {
      if (running || !live || workerRef.current !== worker || currentIdRef.current !== app) return;
      running = true;
      try {
        const tick = await runRetainedAutomationTick(sessionStorage, worker, app);
        const { runs, notifications: inbox } = tick;
        if (!live) return;
        setAutomationStorageAvailable(tick.available); setAutomationWaitReason(tick.reason);
        const signature = JSON.stringify(inbox.map(notification => [
          notification.id, notification.at, notification.read,
        ]));
        if (signature !== notificationProjectionSignature.current) {
          notificationProjectionSignature.current = signature;
          invalidateDailyHome();
        }
        setNotifications(inbox);
        if (runs.some(run => run.changed > 0)) {
          for (const table of registryTables) liveBridge?.notifyWrite(table.name);
          invalidateDailyHome();
        }
        const failed = runs.filter(run => run.status === "failed").length;
        if (failed > 0) pushToast(`${failed} automation run${failed === 1 ? "" : "s"} failed safely`, "danger");
      } catch (error) {
        if (live) pushToast(`Automation check failed: ${error instanceof Error ? error.message : String(error)}`, "danger");
      } finally { running = false; }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 15_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [phase, currentId, liveBridge, registryTables, pushToast]);

  // Styled in-app confirmation (native dialogs read as unfinished and
  // can't be themed). One dialog serves the shell AND sandboxed panels
  // (via the Bridge onConfirm hook).
  const [confirmBox, setConfirmBox] =
    useState<{ msg: string; resolve: (ok: boolean) => void } | null>(null);
  const askConfirm = useCallback((msg: string): Promise<boolean> =>
    new Promise(res => setConfirmBox({ msg, resolve: res })), []);
  const settleConfirm = (ok: boolean): void => {
    confirmBox?.resolve(ok);
    setConfirmBox(null);
  };

  const recordFault = useCallback((panelId: string, fault: PanelFault): void => {
    void client().recordPrivateMetric({
      type: "fault_seen", fault: privateFaultKind(fault.code),
    }, mutationContext()).catch(() => undefined);
    setFaults(f => (f[panelId] ? f : { ...f, [panelId]: fault }));
  }, []);

  const refreshPanels = useCallback(async (): Promise<void> => {
    const [nextPanels, nextHistory, nextTables, nextProvenance,
      nextSemanticTrace, nextFieldProvenance, nextProtection] = await Promise.all([
      client().panels(), client().history(), client().registryTables(),
      client().panelProvenance(), client().semanticTrace(), client().fieldProvenance(),
      client().deviceProtection(),
    ]);
    setPanels(nextPanels);
    setHistory(nextHistory);
    setRegistryTables(nextTables);
    setPanelProvenance(nextProvenance);
    setSemanticTrace(nextSemanticTrace);
    setFieldProvenance(nextFieldProvenance);
    setDeviceProtectionState(nextProtection);
    setFaults({});
  }, []);

  const refreshSuggestions = useCallback(async (): Promise<void> => {
    try { setSuggestions(await client().suggestions()); }
    catch { /* pre-boot */ }
  }, []);

  const refreshProvenance = useCallback(async (): Promise<void> => {
    setPanelProvenance(await client().panelProvenance());
  }, []);

  const recordPrivateMetric = useCallback((event: PrivateMetricEvent): void => {
    void client().recordPrivateMetric(event, mutationContext()).catch(() => undefined);
  }, []);

  const journeyComplete = firstSuccessJourneyComplete(firstSuccess, deviceProtectionState);
  useEffect(() => {
    if (phase !== "main" || activationRecorded.current || !journeyComplete
        || deviceProtectionState?.result.state !== "protected_on_device") return;
    activationRecorded.current = true;
    recordPrivateMetric({ type: "activation_completed",
      elapsed: durationBucket(Date.now() - appReadyAt.current) });
  }, [phase, journeyComplete, deviceProtectionState, recordPrivateMetric]);

  useEffect(() => {
    if (phase !== "main" || !workerRef.current) return;
    const wc = workerRef.current;
    void refreshDeviceProtection(wc);
    const timer = window.setInterval(() => void refreshDeviceProtection(wc), 4_000);
    return () => window.clearInterval(timer);
  }, [phase, refreshDeviceProtection]);

  // Ambient: re-derive the Observer's nudges on a gentle idle cadence so a
  // pattern that appears from data entry (e.g. invoices going overdue) is
  // noticed on its own, not only right after a reshape. Local heuristics
  // only — no model call (P4). Skipped while a preview is open.
  useEffect(() => {
    if (phase !== "main") return;
    const id = setInterval(() => {
      if (!preview) void refreshSuggestions();
    }, 12000);
    return () => clearInterval(id);
  }, [phase, preview, refreshSuggestions]);

  // Color scheme (per app). Apply to the trusted shell root live; the token
  // block for the sandboxed panels is memoised and passed into each iframe.
  useEffect(() => { applyThemeToRoot(themeById(themeId)); }, [themeId]);
  const themeCss = useMemo(() => panelThemeCss(themeById(themeId)), [themeId]);
  const selectTheme = (id: string): void => {
    const appId = currentId ?? currentAppId() ?? "default";
    saveThemeId(appId, id);
    setThemeId(id);
  };

  // boot
  useEffect(() => {
    const worker = new Worker(new URL("../worker/db-worker.ts", import.meta.url),
      { type: "module" });
    const wc = new WorkerClient(worker);
    workerRef.current = wc;
    void (async () => {
      try {
        const cache = listApps();
        const cur = currentApp();
        const boot = await withTimeout(wc.boot({
          requestedAppId: cur?.id ?? null,
          appCache: cache,
        }), 20_000, "Opening the app");
        replaceAppCache(boot.apps, boot.selectedAppInstanceId);
        setPersistent(boot.persistent);

        // Device-global model access remains in trusted shell storage. Authority boot
        // deletes legacy DB credential rows without reading or returning their values;
        // installations that never migrated them require deliberate re-entry.
        const selectedProvider = getModelProvider();
        const access = getActiveModelAccess();
        setModelProviderState(selectedProvider);
        await wc.setModelAccess(prepareWorkerModelAccess(
          access, selectedProvider === "clay" ? getSessionToken(access.backendUrl) : null,
          isAmbientSessionAllowed(access.backendUrl),
        ));
        setHasKey(hasModelAccess());

        const pendingSetup = readAppSetup(sessionStorage);
        if (pendingSetup) {
          onboardingCreatesApp.current = pendingSetup.createsApp && pendingSetup.stage === "target";
          firstRunOnboarding.current = true;
          firstRunTargetId.current = pendingSetup.targetAppInstanceId ?? pendingSetup.sourceAppInstanceId;
          setApps(boot.apps);
          setCurrentId(boot.selectedAppInstanceId);
          setPendingImport(pendingSetup.reviewed);
          setOnboardingError("An app setup was interrupted. Retry to reconcile the same request; no app will be deleted automatically.");
          setPhase("onboarding");
          return;
        }
        if (!boot.seeded && boot.shellId === null) {
          firstRunOnboarding.current = true;
          firstRunTargetId.current = boot.selectedAppInstanceId;
          setApps(boot.apps);
          setCurrentId(boot.selectedAppInstanceId);
          setPhase("onboarding");
          return;
        }
        firstRunOnboarding.current = false;
        firstRunTargetId.current = null;
        setApps(boot.apps);
        setCurrentId(boot.selectedAppInstanceId);
        setLiveBridge(makeBridge(wc, "live", pushToast, recordFault, askConfirm,
          (table, id) => openRecordRef.current(table, id)));
        const [bootPanels, bootHistory, bootTables, bootSuggestions, bootProvenance,
          bootSemanticTrace, bootFieldProvenance, bootFirstRunEvidence,
          bootFirstSuccess, bootProtection] = await Promise.all([
          wc.panels(), wc.history(), wc.registryTables(), wc.suggestions(), wc.panelProvenance(),
          wc.semanticTrace(), wc.fieldProvenance(),
          wc.firstRunEvidence(),
          loadFirstSuccessState(firstSuccessSettings(wc)).catch(() => null),
          wc.deviceProtection().catch(() => null),
        ]);
        setPanels(bootPanels);
        setHistory(bootHistory);
        setRegistryTables(bootTables);
        setSuggestions(bootSuggestions);
        setPanelProvenance(bootProvenance);
        setSemanticTrace(bootSemanticTrace);
        setFieldProvenance(bootFieldProvenance);
        setFirstRunEvidence(bootFirstRunEvidence);
        setFirstSuccess(bootFirstSuccess);
        setDeviceProtectionState(bootProtection);
        const firstJourneyComplete = firstSuccessJourneyComplete(
          bootFirstSuccess, bootProtection,
        );
        const entryMode = readWorkspaceModeForEntry(
          boot.selectedAppInstanceId, firstJourneyComplete,
        );
        setWorkspaceMode(entryMode);
        if (entryMode === "work") setRailOpen(false);
        setFirstSuccessError(bootFirstSuccess ? null
          : "Setup progress could not be loaded. Your records were not changed.");
        setPhase("main");
        void wc.recordPrivateMetric({ type: "app_ready",
          entry: boot.seeded ? "existing" : "new_starter" },
        wc.createMutationContext()).catch(() => undefined);
      } catch (e) {
        // Never hang on the spinner: surface the failure and let the user
        // recover (retry, switch to another app, or start over).
        console.error("[clay boot]", e);
        setApps(listApps());
        setCurrentId(currentApp()?.id ?? null);
        setBootError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
    return (): void => { void wc.shutdown().catch(() => undefined); };
  }, [pushToast, recordFault, updateFirstSuccess]);

  const pickShell = async (id: StarterShellId): Promise<void> => {
    setBusy(true);
    setOnboardingError(null);
    try {
      const sourceId = currentIdRef.current;
      if (!sourceId) throw new Error("The authority-selected source app is unavailable.");
      let setup = beginAppSetup(sessionStorage, { kind: "starter", sourceAppInstanceId: sourceId,
        createsApp: onboardingCreatesApp.current, displayName: shellName(id), shellId: id, reviewed: null,
      }, mutationContext);
      id = setup.shellId as StarterShellId;
      let lifecycleBoot = await client().boot({ requestedAppId: null, appCache: [] });
      if (setup.stage === "target" && setup.createsApp) {
        lifecycleBoot = await withTimeout(
          client().createApp(setup.displayName, id, { requestId: setup.createRequestId }),
          20_000,
          "Creating the app",
        );
        // A retry after starter seeding fails must reuse this exact worker-
        // published app instead of minting another lifecycle request/target.
        onboardingCreatesApp.current = false;
        firstRunOnboarding.current = true;
        firstRunTargetId.current = lifecycleBoot.selectedAppInstanceId;
      } else if (setup.stage === "target" && !lifecycleBoot.seeded) {
        const firstRunId = setup.sourceAppInstanceId;
        if (lifecycleBoot.selectedAppInstanceId !== firstRunId)
          throw new Error("The app selected for setup has changed. No starter was applied.");
        lifecycleBoot = await withTimeout(
          client().renameApp(firstRunId, setup.displayName, { requestId: setup.nameRequestId }, id),
          20_000,
          "Naming the app",
        );
      }
      if (setup.targetAppInstanceId !== null && lifecycleBoot.selectedAppInstanceId !== setup.targetAppInstanceId)
        throw new Error("The app selected for setup has changed. No starter was applied.");
      setup = { ...setup, stage: "apply", targetAppInstanceId: lifecycleBoot.selectedAppInstanceId };
      saveAppSetup(sessionStorage, setup);
      replaceAppCache(lifecycleBoot.apps, lifecycleBoot.selectedAppInstanceId);
      dataStoreRef.current = null;
      const targetId = lifecycleBoot.selectedAppInstanceId;
      const canonicalHistory = await withTimeout(
        client().history(), 20_000, "Checking the first-run app",
      );
      if (canonicalHistory.length === 0) {
        await withTimeout(client().seed(id, { requestId: setup.applyRequestId }), 20_000, "Setting up the app");
      } else {
        // A presentation failure is not permission to relabel an already committed starter.
        const committedStarter = await client().getSetting<string>("shell_id");
        if (!committedStarter) throw new Error("The committed starter identity is unavailable. Existing history was kept.");
        id = committedStarter as StarterShellId;
      }
      setup = { ...setup, stage: "committed" };
      saveAppSetup(sessionStorage, setup);
      await updateFirstSuccess({
        type: "app_created",
        path: id === "blank" ? "blank" : "recommended",
        shellId: id,
      });
      await refreshFirstRunEvidence(client());
      const protection = await withTimeout(
        client().deviceProtection(), 20_000, "Checking the app identity",
      );
      if (!protection.target || protection.target.appInstanceId !== targetId)
        throw new Error("the opened app changed while setup was finishing");
      setDeviceProtectionState(protection);
      setApps(lifecycleBoot.apps);
      setCurrentId(targetId);
      setLiveBridge(makeBridge(client(), "live", pushToast, recordFault, askConfirm,
        (table, rowId) => openRecordRef.current(table, rowId)));
      await refreshPanels();
      finishAppSetup(sessionStorage);
      setFeed([{ kind: "info", text: "Your app is ready. Describe any change to reshape it." }]);
      firstRunOnboarding.current = false;
      firstRunTargetId.current = null;
      onboardingCreatesApp.current = false;
      setPhase("main");
      recordPrivateMetric({ type: "app_ready", entry: "new_starter" });
    } catch (error) {
      setOnboardingError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  // Reload only after graceful planner cancellation and preview discard. The
  // WorkerClient owns a bounded hard-termination fallback for crash recovery.
  const reloadApp = (): void => {
    if (reloadScheduled.current) return;
    reloadScheduled.current = true;
    const current = workerRef.current;
    void (current ? current.shutdown() : Promise.resolve())
      .catch(() => undefined)
      .finally(() => window.location.reload());
  };
  const publishLifecycleBoot = (boot: BootInfo): void => {
    replaceAppCache(boot.apps, boot.selectedAppInstanceId);
    setApps(boot.apps);
    setCurrentId(boot.selectedAppInstanceId);
  };
  const switchApp = async (id: string): Promise<void> => {
    if (id === currentIdRef.current) return;
    setBusy(true);
    try {
      publishLifecycleBoot(await withTimeout(
        client().switchApp(id, mutationContext()), 20_000, "Switching apps",
      ));
    } catch (error) {
      pushToast(error instanceof Error ? error.message : "Couldn’t switch apps.", "danger");
    } finally {
      reloadApp();
    }
  };
  const newApp = (): void => {
    onboardingCreatesApp.current = true;
    setPendingImport(null);
    setOnboardingError(null);
    setPhase("onboarding");
  };
  const reviewNewAppImport = async (file: File): Promise<void> => {
    setBusy(true);
    setOnboardingError(null);
    try {
      if (readAppSetup(sessionStorage)) throw new Error("Finish the pending setup before choosing another file.");
      const parserAppId = currentIdRef.current;
      if (!parserAppId) throw new Error("The current app identity is unavailable.");
      const { newAppImportDisplayName, parseNewAppImportFile } =
        await import("./new-app-import");
      setPendingImport({
        fileName: file.name,
        displayName: newAppImportDisplayName(file.name),
        parsed: await parseNewAppImportFile(file, parserAppId),
      });
    } catch (error) {
      setOnboardingError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const confirmUnprotectedNewApp = async (): Promise<boolean> => {
    let persisted = false;
    try { persisted = (await client().requestPersist()).persisted; }
    catch { /* An unreadable permission result is not protection evidence. */ }
    if (persisted) return true;
    return askConfirm(persistent
      ? "Clay cannot protect this imported app on this device yet. If you continue, it could be lost if this browser clears its site data. Continue anyway?"
      : "Clay cannot protect this imported app on this device yet. If you continue, it can disappear when this tab closes. Continue with temporary storage?");
  };
  const importNewApp = async (): Promise<void> => {
    const reviewed = pendingImport;
    if (!reviewed) return;
    if (!await confirmUnprotectedNewApp()) return;
    setBusy(true);
    setOnboardingError(null);
    try {
      const sourceId = currentIdRef.current;
      if (!sourceId) throw new Error("The authority-selected source app is unavailable.");
      let setup = beginAppSetup(sessionStorage, { kind: "import", sourceAppInstanceId: sourceId,
        createsApp: onboardingCreatesApp.current, displayName: reviewed.displayName, shellId: "blank", reviewed,
      }, mutationContext);
      const original = setup.reviewed;
      if (!original) throw new Error("The retained import preview is unavailable.");
      let created = await client().boot({ requestedAppId: null, appCache: [] });
      if (setup.stage === "target") {
        if (setup.createsApp) {
          created = await withTimeout(client().createApp(setup.displayName, "blank",
            { requestId: setup.createRequestId }), 20_000, "Creating the imported app");
        } else {
          if (created.selectedAppInstanceId !== setup.sourceAppInstanceId || created.apps.length !== 1 || created.seeded)
            throw new Error("First-run import requires the original empty selected app.");
          if (!setup.firstRunTarget) {
            const target = (await client().deviceProtection()).target;
            if (!target) throw new Error("The first-run target identity is unavailable.");
            setup = { ...setup, firstRunTarget: { appInstanceId: target.appInstanceId,
              activeGenerationId: target.activeGenerationId, lineageEpoch: target.lineageEpoch,
              protectionRevision: target.stateRevision, digestSchema: 1, stateSha256: target.stateDigest } };
            saveAppSetup(sessionStorage, setup);
          }
          created = await client().renameApp(setup.sourceAppInstanceId, setup.displayName,
            { requestId: setup.nameRequestId });
        }
        setup = { ...setup, targetAppInstanceId: created.selectedAppInstanceId, stage: "apply" };
        saveAppSetup(sessionStorage, setup);
      }
      if (created.selectedAppInstanceId !== setup.targetAppInstanceId)
        throw new Error("The selected app changed. The retained import has not been applied to another target.");
      publishLifecycleBoot(created);
      dataStoreRef.current = null;
      const importBinding = setup.firstRunTarget ?? setup.createRequestId;
      const result = await withTimeout(client().importNewApp(
        importBinding,
        {
          table: original.parsed.table,
          columns: original.parsed.columns,
          rows: original.parsed.rows,
        },
        { requestId: setup.applyRequestId },
      ), 30_000, "Importing the reviewed rows");
      if (result.appInstanceId !== created.selectedAppInstanceId)
        throw new Error("The imported app identity changed before read-back.");
      setup = { ...setup, stage: "committed" };
      saveAppSetup(sessionStorage, setup);
      firstRunOnboarding.current = false;
      firstRunTargetId.current = null;
      onboardingCreatesApp.current = false;
      setLiveBridge(makeBridge(client(), "live", pushToast, recordFault, askConfirm,
        (table, rowId) => openRecordRef.current(table, rowId)));
      await refreshPanels();
      finishAppSetup(sessionStorage);
      setPendingImport(null);
      setWorkspaceMode("customize");
      setPhase("main");
      pushToast(
        `Imported ${result.imported} row${result.imported === 1 ? "" : "s"} into a new app.`,
        "success",
        {
          label: "Undo",
          run: () => {
            void (async () => {
              setBusy(true);
              try {
                await client().undoNewAppImport(
                  importBinding, setup.applyRequestId, { requestId: setup.undoRequestId },
                );
                dataStoreRef.current = null;
                await refreshPanels();
                pushToast("Import undone. The empty app is still available.", "success");
              } catch (error) {
                pushToast(error instanceof Error ? error.message : "Couldn’t undo the import.", "danger");
              } finally {
                setBusy(false);
              }
            })();
          },
        },
      );
    } catch (error) {
      // Timeout and post-commit readback/presentation errors are outcome-ambiguous.
      // The exact request remains retained for reconciliation. Never delete its target.
      setOnboardingError((error instanceof Error ? error.message : String(error))
        + " No app was deleted. Retry (or reload and retry) to reconcile the same import receipt.");
    } finally {
      setBusy(false);
    }
  };
  // Duplicate canonical state into a separately declared physical generation;
  // the worker publishes the fresh target only after exact read-back succeeds.
  const forkApp = async (): Promise<void> => {
    setBusy(true);
    try {
      publishLifecycleBoot(await withTimeout(
        client().forkApp(mutationContext()), 20_000, "Duplicating the app",
      ));
    } catch (error) {
      pushToast(error instanceof Error ? error.message : "Couldn’t duplicate this app.", "danger");
    } finally {
      reloadApp();
    }
  };
  const deleteApp = async (id: string): Promise<void> => {
    const entry = apps.find(a => a.id === id);
    if (apps.length < 2) {
      pushToast("Clay keeps at least one usable app on this device.", "default");
      return;
    }
    if (!(await askConfirm(
      `Delete “${entry?.name ?? "this app"}” and all of its data? `
      + "This cannot be undone. (Export a .clay backup first if unsure.)"))) return;
    setBusy(true);
    try {
      publishLifecycleBoot(await withTimeout(
        client().deleteApp(id, mutationContext()), 20_000, "Deleting the app",
      ));
    } catch (error) {
      pushToast(error instanceof Error ? error.message : "Couldn’t delete this app.", "danger");
    } finally {
      reloadApp();
    }
  };
  const renameCurrentApp = async (id: string, name: string): Promise<void> => {
    setBusy(true);
    try {
      publishLifecycleBoot(await withTimeout(
        client().renameApp(id, name, mutationContext()), 20_000, "Renaming the app",
      ));
    } catch (error) {
      pushToast(error instanceof Error ? error.message : "Couldn’t rename this app.", "danger");
    } finally {
      reloadApp();
    }
  };

  const handleOutcome = (outcome: IntentOutcome): void => {
    if (outcome.status === "clarify") {
      recordPrivateMetric({ type: "reshape_finished", outcome: "clarify",
        repaired: outcome.repaired, stage: "plan", diff: "unknown" });
      setFeed(f => [...f, { kind: "clarify", question: outcome.question }]);
    } else if (outcome.status === "failed") {
      recordPrivateMetric({ type: "reshape_finished", outcome: "failed",
        repaired: outcome.repaired, stage: outcome.stage as "plan" | "validate" | "dry_run",
        diff: "unknown" });
      setFeed(f => [...f, { kind: "failure", reasons: outcome.reasons }]);
    } else {
      recordPrivateMetric({ type: "reshape_finished", outcome: "preview",
        repaired: outcome.preview.repaired, stage: "none",
        diff: deriveSafeDiffKind(outcome.preview.diff) });
      setPreview(outcome.preview);
      void updateFirstSuccess({
        type: "reshape_previewed", baseVersion: outcome.preview.version,
      });
      setShadowBridge(makeBridge(client(), "shadow", pushToast, recordFault, askConfirm));
    }
  };

  const runIntent = async (
    text: string, origin: "composer" | "observer_suggestion" = "composer",
  ): Promise<void> => {
    if (busy || preview || scrub) return;
    recordPrivateMetric({ type: "reshape_started", origin });
    setFeed(f => [...f, { kind: "intent", text }]);
    // Dummy/sample-data intents are handled by the trusted shell, not the
    // planner — the model can't insert rows by design, so routing these to
    // it dead-ends (it can only offer a form). Instant, free, reversible.
    // Guarded: only plain fill/clear asks, not UI requests that mention
    // sample data ("add a button to load demo data" still goes to the model).
    const sampley = /\b(dummy|sample|demo|fake)[- ]?(data|rows|records|entries)\b/i;
    const uiAsk = /\b(button|panel|form|chart|view|field|column|badge|dashboard)\b/i;
    const clearVerb = /\b(clear|remove|delete|drop|reset|clean)\b/i;
    const fillVerb = /\b(populate|fill|add|insert|seed|generate|create|load|simulate|put)\b/i;
    if (sampley.test(text) && !uiAsk.test(text)
        && (clearVerb.test(text) || fillVerb.test(text))) {
      const clearing = clearVerb.test(text);
      setBusy(true);
      try {
        if (clearing) {
          const result = await client().removeSamples(mutationContext());
          setFeed(f => [...f, { kind: "info", text: result.affected === 0
            ? `No active sample rows needed clearing. ${result.recovery.recoverable} generated row${result.recovery.recoverable === 1 ? " remains" : "s remain"} recoverable under deleted rows.`
            : `Cleared ${result.affected} generated sample row${result.affected === 1 ? "" : "s"}; ${result.recovery.recoverable} can be restored from deleted rows.` }]);
        } else {
          const res = await client().fillSamples(mutationContext());
          setFeed(f => [...f, {
            kind: "info",
            text: res.added > 0
              ? `Filled your tables with ${res.added} sample rows so you can see the app working. Say “clear the sample data” (or use Data → Clear samples) to remove exactly these rows later.`
              : "There are no tables to fill yet — describe the app first, then I can add sample data.",
          }]);
        }
        // wake every live panel's watch — rows changed under them. No
        // refreshPanels here: panels themselves didn't change, and the panel
        // list churn is what used to sever mounted panels from the bridge.
        for (const t of await client().registryTables()) liveBridge?.notifyWrite(t.name);
      } catch (e) {
        setFeed(f => [...f, { kind: "failure", reasons: [String(e)] }]);
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    try {
      handleOutcome(await client().intent(text, mutationContext()));
    } catch (e) {
      setFeed(f => [...f, { kind: "failure", reasons: [String(e)] }]);
    } finally {
      setBusy(false);
      // hosted mode: every plan call moves the quota — keep the meter honest
      if (modelProvider === "clay" && getBackendUrl()) setAccountN(n => n + 1);
    }
  };

  const acceptSuggestion = (s: Suggestion): void => {
    if (busy || preview || scrub) return;
    void client().acceptSuggestion(s.subject, s.kind, mutationContext());
    setSuggestions(list => list.filter(x => x.id !== s.id));
    void runIntent(s.intent, "observer_suggestion");
  };

  const dismissSuggestion = (s: Suggestion): void => {
    void client().dismissSuggestion(s.subject, s.kind, mutationContext());
    setSuggestions(list => list.filter(x => x.id !== s.id));
  };

  // doc 05 §7 boundary actions
  const repairPanel = async (panelId: string): Promise<void> => {
    if (busy || preview || scrub) return;
    const fault = faults[panelId];
    if (!fault) return;
    recordPrivateMetric({ type: "reshape_started", origin: "panel_repair" });
    setFeed(f => [...f, { kind: "info", text: `Repairing ${panelId} (${fault.message.slice(0, 80)})…` }]);
    setBusy(true);
    try {
      const outcome = await client().repairPanel(panelId, fault.message, mutationContext());
      if (outcome.status === "preview") pendingRecovery.current = "panel_repair";
      else recordPrivateMetric({ type: "recovery_finished",
        method: "panel_repair", result: "failed" });
      handleOutcome(outcome);
    } catch (e) {
      recordPrivateMetric({ type: "recovery_finished",
        method: "panel_repair", result: "failed" });
      setFeed(f => [...f, { kind: "failure", reasons: [String(e)] }]);
    } finally {
      setBusy(false);
    }
  };

  const revertPanel = async (panelId: string): Promise<void> => {
    try {
      setPanels(await client().revertPanel(panelId, mutationContext()));
      setHistory(await client().history());
      await refreshProvenance();
      setFaults(f => { const { [panelId]: _drop, ...rest } = f; return rest; });
      setFeed(f => [...f, { kind: "info", text: `Rolled back the ${panelId} panel.` }]);
      recordPrivateMetric({ type: "recovery_finished",
        method: "panel_revert", result: "success" });
    } catch (e) {
      recordPrivateMetric({ type: "recovery_finished",
        method: "panel_revert", result: "failed" });
      pushToast(String(e instanceof Error ? e.message : e), "danger");
    }
  };

  const dismissFault = (panelId: string): void => {
    setFaults(f => { const { [panelId]: _drop, ...rest } = f; return rest; });
  };

  const exportArchive = async (): Promise<void> => {
    if (downloadBusy.current || !currentIdRef.current) return;
    downloadBusy.current = true;
    const appId = currentIdRef.current;
    try {
      const recovery = new ManualDownloadRecovery(sessionStorage, client());
      if (!recovery.pending(appId)) {
        const { bytes, filename, download } = await client().exportArchive();
        try {
          if (currentIdRef.current !== appId) throw new Error("Open app changed before download. No file was handed off.");
          const pending = recovery.prepare(appId, { ...download, startedAt: new Date().toISOString() });
          setPendingDownloadRecord(pending);
          startBrowserDownload(filename, bytes, "application/octet-stream");
          recovery.handedOff(appId, pending.requestId);
        } finally { new Uint8Array(bytes).fill(0); }
      }
      if (currentIdRef.current !== appId) throw new Error("Switch back to the original app to reconcile its download request.");
      await recovery.resume(appId);
      const downloads = await client().manualBackupDownloads();
      if (currentIdRef.current === appId) { setPendingDownloadRecord(null); setManualDownloads(downloads); }
      pushToast("Download record checked. Check the saved file; external storage is not verified.", "success");
      recordPrivateMetric({ type: "backup_finished", action: "export", result: "success" });
    } catch (error) {
      pushToast(error instanceof Error ? error.message : "Download recovery needs retry.", "danger",
        { label: "Recovery Center", run: () => openRecoveryCenter() });
      recordPrivateMetric({ type: "backup_finished", action: "export", result: "failed" });
    } finally { downloadBusy.current = false; }
  };

  const resumeManualDownload = async (file?: File): Promise<boolean> => {
    const appId = currentIdRef.current; if (!appId || downloadBusy.current) return false;
    downloadBusy.current = true;
    let bytes: ArrayBuffer | undefined;
    try {
      if (file) bytes = await boundedFileBytes(file, (await loadProductionBackupRuntime()).MAX_BACKUP_ARCHIVE_BYTES, "Downloaded backup");
      if (currentIdRef.current !== appId) throw new Error("Open app changed; return to the download's original app.");
      const result = await new ManualDownloadRecovery(sessionStorage, client()).resume(appId, bytes);
      await refreshRecoveryState(); return result;
    } finally {
      if (bytes?.byteLength) new Uint8Array(bytes).fill(0);
      downloadBusy.current = false;
    }
  };
  const discardManualDownload = async (): Promise<boolean> => {
    const appId = currentIdRef.current;
    if (!appId || downloadBusy.current) return false;
    downloadBusy.current = true;
    try {
      if (!(await askConfirm("Discard this unfinished download request? No file or saved backup record will be deleted."))) return false;
      if (currentIdRef.current !== appId) throw new Error("Open app changed; nothing discarded.");
      await new ManualDownloadRecovery(sessionStorage, client()).discard(appId);
      await refreshRecoveryState(); return true;
    } finally { downloadBusy.current = false; }
  };

  const refreshRecoveryState = async (): Promise<void> => {
    if (!currentId) return;
    const appId = currentId;
    await runLatestRequest(recoveryRefreshGate, async () => {
      const runtime = await loadProductionBackupRuntime();
      const [trust, records, batches, candidates, downloads, retention] = await Promise.all([
        client().backupTrustStatus(),
        client().backupRecords(true),
        client().operationBatches(20),
        client().recoveryCandidates(),
        client().manualBackupDownloads(),
        client().backupRetentionHistory(),
      ]);
      let storedTarget: ProductionBackupTargetState | null = null;
      try { storedTarget = runtime.loadProductionBackupTarget(localStorage, appId); }
      catch { /* storage can be unavailable in private mode */ }
      const adapter = await ensureBackupAdapter();
      let authorizedTarget: ProductionBackupTargetState | null = null;
      if (storedTarget && adapter) {
        const authorization = await adapter.probe(storedTarget.target);
        if (authorization.status === "authorized") authorizedTarget = storedTarget;
      }
      return {
        trust,
        downloads,
        pendingDownload: new ManualDownloadRecovery(sessionStorage, client()).pending(appId),
        storedTarget,
        authorizedTarget,
        history: recoveryBackupSummaries(records, appId, retention),
        retentionWork: runtime.productionRetentionWork(records, localStorage),
        batches,
        candidates,
        failures: loadRecoveryFailures(appId),
      };
    }, snapshot => {
      if (currentIdRef.current !== appId) return;
      setBackupTrustStatus(snapshot.trust);
      setManualDownloads(snapshot.downloads);
      setPendingDownloadRecord(snapshot.pendingDownload);
      setBackupTargetHint(snapshot.storedTarget);
      setBackupTarget(snapshot.authorizedTarget);
      setBackupHistory(snapshot.history);
      setBackupRetentionWork(snapshot.retentionWork);
      setRecoveryBatches(snapshot.batches);
      setRecoveryRecords(snapshot.candidates);
      setRecoveryActionFailures(snapshot.failures);
    });
  };

  const recordBackupFailure = (reasonCode: BackupFailureReasonCode): void => {
    const id = `backup-failure-${++backupFailureId.current}`;
    setBackupFailures(current => [{
      id,
      at: new Date().toISOString(),
      reasonCode,
    }, ...current].slice(0, 20));
  };

  const resumeBackupRetention = async (scope: RecoveryRetentionWork["scope"]): Promise<void> => {
    const runtime = await loadProductionBackupRuntime();
    const hint = runtime.loadProductionBackupTarget(localStorage, scope.appInstanceId, scope.targetId);
    const adapter = backupAdapterRef.current;
    if (!hint || !adapter || hint.target.adapterCertificationId !== scope.adapterCertificationId)
      throw new Error("Original backup folder capability is unavailable. Work is quarantined; files are kept.");
    const authorization = await adapter.reauthorizeFromUserGesture(hint.target);
    if (authorization.status !== "authorized") throw new Error("Original folder permission needs renewal. No files were removed.");
    if (!(await askConfirm(`Resume bounded retention in ${hint.folderName}? Only older receipt-bound backups are eligible; the newest 32 publications are kept.`))) return;
    await runtime.runProductionBackupRetention(client(), adapter.directory(hint.target), scope);
    await refreshRecoveryState();
  };

  const runAutomaticBackup = async (
    state: ProductionBackupTargetState,
    reason: BackupRun["reason"],
  ): Promise<boolean> => {
    try {
      const [runtime, adapter] = await Promise.all([
      loadProductionBackupRuntime(), ensureBackupAdapter(),
    ]);
    if (!adapter) {
      recordBackupFailure("unsupported_api");
      return false;
    }
      const result = await runtime.runProductionAutomaticBackup(
        client(), adapter, state.target, reason,
      );
      if (result.status === "failed") {
        recordBackupFailure(result.reasonCode);
        pushToast("Backup not verified; the earlier copy was kept.", "danger");
        return false;
      }
      setBackupFailures([]);
      await refreshRecoveryState();
      try { localStorage.setItem("clay_last_backup", String(Date.now())); }
      catch { /* private mode */ }
      pushToast(result.rotation.failed > 0 ? "Backup published; some older files need retention retry." : "Backup written and verified", "success");
      return true;
    } catch {
      recordBackupFailure("target_unreachable");
      pushToast("Backup or retention needs recovery. Check the exact outcome in Recovery Center.", "danger");
      return false;
    }
  };

  const exportRecoveryKit = async (): Promise<void> => {
    const enrollment = await client().beginBackupTrustEnrollment();
    try {
      startBrowserDownload(enrollment.fileName, enrollment.bytes, "text/plain;charset=utf-8");
    } finally {
      enrollment.bytes.fill(0);
    }
    setBackupTrustStatus(await client().backupTrustStatus());
    pushToast("Recovery Kit downloaded — check that exact file in Recovery Center", "success");
  };

  const confirmRecoveryKit = async (file: File): Promise<void> => {
    const status = await client().backupTrustStatus();
    if (status.status !== "needs_test_import")
      throw new Error("Recovery Kit enrollment is unavailable");
    const bytes = await boundedFileBytes(file, MAX_RECOVERY_KIT_BYTES, "Recovery Kit");
    const ready = await client().confirmBackupTrustEnrollment(
      status.enrollmentId,
      bytes,
    );
    setBackupTrustStatus(ready);
    pushToast("Recovery Kit checked — authenticated backup is ready", "success");
    if (backupTarget) await runAutomaticBackup(backupTarget, "backup_now");
  };

  const importRecoveryKit = async (file: File): Promise<void> => {
    const bytes = await boundedFileBytes(file, MAX_RECOVERY_KIT_BYTES, "Recovery Kit");
    const imported = await client().importRecoveryKit(bytes);
    const active = await client().backupTrustStatus();
    setBackupTrustStatus(active);
    setImportedVerifierSeriesId(imported.activeForBackup ? null : imported.seriesId);
    pushToast(imported.activeForBackup
      ? "Recovery Kit verified for the active backup series"
      : "Recovery Kit imported for restore verification; future backups still use the active series",
    "success");
    if (imported.activeForBackup && backupTarget)
      await runAutomaticBackup(backupTarget, "backup_now");
  };

  const activateImportedBackupSeries = async (seriesId: string): Promise<void> => {
    const expectedActiveSeriesId = backupTrustStatus?.status === "ready"
      ? backupTrustStatus.seriesId : null;
    if (!(await askConfirm(
      "Use the imported Recovery Kit series for every future backup on this device? "
      + "This is an explicit trust rotation; the previous series will no longer receive backups.",
    ))) return;
    const active = await client().activateImportedBackupSeries(seriesId, expectedActiveSeriesId);
    setBackupTrustStatus(active);
    setImportedVerifierSeriesId(null);
    pushToast("Imported Recovery Kit series activated for future backups", "success");
    if (backupTarget) await runAutomaticBackup(backupTarget, "backup_now");
  };

  const chooseBackupFolder = async (): Promise<void> => {
    try {
      const [runtime, adapter] = await Promise.all([
      loadProductionBackupRuntime(), ensureBackupAdapter(),
    ]);
    if (!adapter || !currentId) return;
    const availability = adapter.availability();
    if (availability.status === "unavailable") {
      recordBackupFailure(closedBackupFailureCode(availability.reasonCode));
      return;
    }
    const authorization = backupTargetHint
      ? await adapter.reauthorizeFromUserGesture(backupTargetHint.target)
      : await adapter.authorizeFromUserGesture(currentId);
    if (authorization.status === "unavailable") {
      recordBackupFailure(closedBackupFailureCode(authorization.reasonCode));
      return;
    }
    const handle = await adapter.reacquire(authorization.target);
    const next = Object.freeze({
      target: authorization.target,
      folderName: handle.name,
    });
    try { runtime.saveProductionBackupTarget(localStorage, next); }
    catch { /* the target remains usable for this session */ }
    setBackupTargetHint(next);
    setBackupTarget(next);
    const trust = await client().backupTrustStatus();
    setBackupTrustStatus(trust);
    if (trust.status === "ready") await runAutomaticBackup(next, "backup_now");
    else pushToast("Folder chosen — finish checking your Recovery Kit to start backup", "default");
    } catch {
      setBackupAdapterStatus("error");
      recordBackupFailure("target_unreachable");
      pushToast("Backup folder support could not load. Try again.", "danger");
    }
  };

  const retryBackup = async (): Promise<void> => {
    if (backupTarget) await runAutomaticBackup(backupTarget, "retry");
  };

  const validateRestore = async (file: File): Promise<unknown> => {
    const { MAX_BACKUP_ARCHIVE_BYTES } = await loadProductionBackupRuntime();
    const bytes = await boundedFileBytes(
      file, MAX_BACKUP_ARCHIVE_BYTES, "Authenticated backup",
    );
    return client().validateRestoreArchive(bytes);
  };

  const restoreAsNew = async (grant: AuthenticatedFormat5RestoreGrant, context: import("./worker-client").WorkerMutationContext): Promise<void> => {
    const boot = await client().restoreAsNew(grant, context);
    replaceAppCache(boot.apps, boot.selectedAppInstanceId);
    setShowRecoveryCenter(false);
    reloadApp();
  };

  const recordRecoveryFailure = (
    action: RecoveryActionFailure["action"],
    error: unknown,
  ): void => {
    if (!currentId) return;
    const failureTime = Date.now();
    const nextFailure: RecoveryActionFailure = {
      id: `recovery-failure-${failureTime}-${++recoveryFailureId.current}`,
      at: new Date(failureTime).toISOString(),
      action,
      code: recoveryActionCode(error),
    };
    setRecoveryActionFailures(current => {
      const next = [nextFailure, ...current].slice(0, 20);
      try {
        localStorage.setItem(`${RECOVERY_FAILURE_PREFIX}${currentId}`, JSON.stringify(next));
      } catch { /* in-memory history remains available for this session */ }
      return next;
    });
  };

  const restoreRecoveryRecord = async (
    candidate: RecoveryRecordCandidate,
  ): Promise<boolean> => {
    const confirmed = await askConfirm(
      `${candidate.deleted ? "Restore this deleted" : "Undo the latest change to this"} `
      + `${candidate.table} record${candidate.attachmentCount > 0
        ? ` and its ${candidate.attachmentCount} attached file${candidate.attachmentCount === 1 ? "" : "s"}`
        : ""}? The current snapshot remains in history. Conflicting relationships stop safely.`,
    );
    if (!confirmed) return false;
    try {
      await client().restoreRow(candidate.table, candidate.id, mutationContext());
      liveBridge?.notifyWrite(candidate.table);
      await Promise.all([refreshPanels(), refreshRecoveryState()]);
      return true;
    } catch (error) {
      recordRecoveryFailure("record", error);
      throw error;
    }
  };

  const undoRecoveryBatch = async (batch: BatchReceipt): Promise<boolean> => {
    if (!(await askConfirm(
      `Undo “${batch.summary}” across ${batch.changed} record${batch.changed === 1 ? "" : "s"}? `
      + "Clay will stop without publishing if later edits conflict.",
    ))) return false;
    try {
      await client().undoBatch(batch.id, mutationContext());
      for (const table of registryTables) liveBridge?.notifyWrite(table.name);
      await Promise.all([refreshPanels(), refreshRecoveryState()]);
      return true;
    } catch (error) {
      recordRecoveryFailure("batch", error);
      throw error;
    }
  };

  const rewindRecoveryStructure = async (version: number): Promise<boolean> => {
    if (!(await askConfirm(
      `Rewind the app structure to version ${version}? Later structural versions will be removed; `
      + "record data is preserved unless those versions changed its schema.",
    ))) return false;
    try {
      await client().makeLatest(version, mutationContext());
      setScrub(null);
      await Promise.all([refreshPanels(), refreshRecoveryState()]);
      setFeed(current => [...pruneFeedAfterVersion(current, version), {
        kind: "info", text: `Rewound — v${version} is the latest again.`,
      }]);
      return true;
    } catch (error) {
      recordRecoveryFailure("structure", error);
      throw error;
    }
  };

  const retryBackupAdapter = async (): Promise<void> => {
    try { await ensureBackupAdapter(); }
    catch { pushToast("Backup folder support could not load. Try again.", "danger"); }
  };

  const openRecoveryCenter = (): void => {
    retryAutomaticBackupRuntime();
    void retryBackupAdapter();
    setShowRecoveryCenter(true);
    void refreshRecoveryState().catch(() => {
      setBackupTrustStatus(null);
      pushToast("Recovery status is temporarily unavailable", "danger");
    });
  };

  useEffect(() => {
    if (phase !== "main" || !currentId || !backupTarget
        || backupTrustStatus?.status !== "ready" || !workerRef.current) return;
    const wc = workerRef.current;
    let retryTimer: number | null = null;
    const inspect = async (
      controller: AutomaticBackupTriggerController,
      isActive: () => boolean,
    ): Promise<void> => {
      try {
        const [selection, records] = await Promise.all([
          wc.backupSelection(),
          wc.backupRecords(),
        ]);
        if (!isActive()
            || selection.selected.selectedAppInstanceId !== currentId) return;
        const exact = records.some(record => record.state === "valid"
          && record.targetId === backupTarget.target.targetId
          && record.evidence.appInstanceId === selection.selected.target.appInstanceId
          && record.evidence.activeGenerationId === selection.selected.target.activeGenerationId
          && record.evidence.lineageEpoch === selection.selected.target.lineageEpoch
          && record.evidence.protectionRevision === selection.selected.target.protectionRevision
          && record.evidence.digestSchema === selection.selected.target.digestSchema
          && record.evidence.stateSha256 === selection.selected.target.stateSha256);
        if (!exact) controller.notifyAuthorityCommit(selection.selected.target);
      } catch { /* Recovery Center reports durable failure on an attempted run. */ }
    };
    const refreshPermission = (): void => {
      retryAutomaticBackupRuntime();
      void refreshRecoveryState();
    };
    window.addEventListener("focus", refreshPermission);
    document.addEventListener("visibilitychange", refreshPermission);
    const stopSession = beginLazySession(
      loadAutomaticBackupTriggerRuntime,
      (module, isActive) => {
        automaticBackupLoadFailed.current = false;
        automaticBackupRetryAttempts.current = 0;
        const controller = new module.AutomaticBackupTriggerController({
          getTarget: () => backupTarget,
          run: runAutomaticBackup,
        });
        const unsubscribe = wc.onAuthorityCommit(notice => {
          controller.notifyAuthorityCommit(notice);
        });
        void inspect(controller, isActive);
        const interval = window.setInterval(() => {
          void inspect(controller, isActive);
        }, 60_000);
        return () => {
          window.clearInterval(interval);
          unsubscribe();
          controller.stop();
        };
      },
      () => {
        automaticBackupLoadFailed.current = true;
        const attempt = ++automaticBackupRetryAttempts.current;
        recordBackupFailure("operation_interrupted");
        const willRetry = attempt <= 2;
        pushToast(willRetry
          ? "Automatic backup could not start. Clay will retry."
          : "Automatic backup is paused. Open Recovery Center to retry.", "danger");
        if (willRetry) retryTimer = window.setTimeout(
          retryAutomaticBackupRuntime, attempt * 2_000,
        );
      },
    );
    return () => {
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      stopSession();
      window.removeEventListener("focus", refreshPermission);
      document.removeEventListener("visibilitychange", refreshPermission);
    };
  }, [
    phase,
    currentId,
    backupTarget?.target.targetId,
    backupTrustStatus?.status,
    automaticBackupLoadGeneration,
  ]);

  // Local-first means the user carries the backup burden — carry it FOR
  // them as far as a browser allows: a gentle weekly nudge with a
  // one-click export. Never more than once per session.
  const backupNudged = useRef(false);
  useEffect(() => {
    if (phase !== "main" || backupNudged.current) return;
    backupNudged.current = true;
    let last = 0;
    try { last = Number(localStorage.getItem("clay_last_backup") ?? 0); } catch { /* private mode */ }
    const days = (Date.now() - last) / 86400000;
    if (history.length > 2 && days > 7) {
      pushToast(
        last === 0 ? "Your data lives only in this browser — keep a backup file"
          : `Last backup ${Math.floor(days)} days ago`,
        "default", { label: "Export now", run: () => void exportArchive() });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, history.length]);

  const copyDiagnostics = async (): Promise<void> => {
    const log = await client().debugLog();
    const text = JSON.stringify(log, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      pushToast(`Copied ${log.length} attempt trace(s) to clipboard`, "success");
    } catch {
      // clipboard blocked — dump to console as a fallback
      console.log("[clay diagnostics]", text);
      pushToast("Diagnostics logged to the console (F12)", "default");
    }
  };

  const rememberSurfaceReturnFocus = (): void => {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const persistentTrigger = active?.closest(".shape-map")
      ? 'button[aria-label="Open shape map"]'
      : active?.closest(".command-palette")
        ? 'button[aria-label="Search and act"]'
        : active?.closest(".automation-center")
          ? 'button[aria-label="Open automations"]' : null;
    surfaceReturnFocus.current = persistentTrigger
      ? document.querySelector<HTMLElement>(persistentTrigger) : active;
  };
  const restoreSurfaceFocus = (): void => {
    const target = surfaceReturnFocus.current;
    surfaceReturnFocus.current = null;
    target?.focus();
  };
  const ensureDataStore = (): StoreRpcClient => {
    dataStoreRef.current ??= new StoreRpcClient(
      portFromMessagePort(client().openStorePort("live")));
    return dataStoreRef.current;
  };
  const openAutomations = (recipe?: "recurring_record", automationId?: string): void => {
    setAutomationRecipe(recipe);
    setAutomationTargetId(automationId);
    setShowAutomations(true);
  };
  const openCommandPalette = (capture = false): void => {
    rememberSurfaceReturnFocus();
    ensureDataStore();
    setQuickCaptureMode(capture);
    setShowCommandPalette(true);
  };

  const openData = (table?: string, recordId?: string, savedViewId?: string): void => {
    rememberSurfaceReturnFocus();
    ensureDataStore();
    setDataTable(table ?? null);
    setDataRecord(recordId ?? null);
    setDataSavedView(savedViewId ?? null);
    setShowData(true);
  };
  const startEverydayAction = async (): Promise<void> => {
    chooseWorkspaceMode("work");
    try {
      await openEverydayActionTarget(client(), openData);
      pushToast("Opened your real record. Reviewing it completes this step.", "info");
    } catch (error) {
      pushToast(error instanceof Error ? error.message : String(error), "danger");
    }
  };
  openRecordRef.current = (table, id): void => openData(table, id);
  const closeData = (): void => {
    setShowData(false);
    setDataRecord(null);
    setDataSavedView(null);
  };

  const closePreview = (): void => {
    setPreview(null);
    setShadowBridge(null);
  };

  const keep = async (): Promise<void> => {
    if (!preview) return;
    let version: number;
    try {
      ({ version } = await client().keep(mutationContext()));
    } catch (error) {
      try { await client().discard(mutationContext()); }
      catch { /* preview may already be closed */ }
      setFeed(feedItems => [...feedItems, { kind: "failure", reasons: [String(error)] }]);
      closePreview();
      await refreshPanels();
      if (pendingRecovery.current) {
        recordPrivateMetric({ type: "recovery_finished",
          method: pendingRecovery.current, result: "failed" });
        pendingRecovery.current = null;
      }
      return;
    }
    const receipt = buildTrustReceipt(preview, version);
    recordPrivateMetric({ type: "preview_decided", decision: "kept",
      repaired: preview.repaired, diff: deriveSafeDiffKind(preview.diff) });
    if (pendingRecovery.current) {
      recordPrivateMetric({ type: "recovery_finished",
        method: pendingRecovery.current, result: "success" });
      pendingRecovery.current = null;
    }
    if (firstKeepAt.current === null) firstKeepAt.current = Date.now();
    await updateFirstSuccess({
      type: "reshape_kept",
      version,
      changed: preview.diff.length > 0 || preview.panels.length > 0 || preview.removePanels.length > 0,
    });
    setFeed(f => [...f, { kind: "committed", summary: preview.summary, version, receipt }]);
    resetLens();
    closePreview();
    await refreshPanels();   // hot swap: keyed remount against the new blobs
    await refreshSuggestions();
    // Rewind through the same confirmed path as History. If later versions
    // exist when this toast is clicked, they are named before truncation.
    pushToast(`Kept — your app is now v${version}`, "success", {
      label: "Rewind",
      run: () => void restoreToRef.current(version - 1),
    });
  };

  const discard = async (): Promise<void> => {
    if (!preview) return;
    await client().discard(mutationContext());
    recordPrivateMetric({ type: "preview_decided", decision: "discarded",
      repaired: preview.repaired, diff: deriveSafeDiffKind(preview.diff) });
    if (pendingRecovery.current) {
      recordPrivateMetric({ type: "recovery_finished",
        method: pendingRecovery.current, result: "discarded" });
      pendingRecovery.current = null;
    }
    setFeed(f => [...f, { kind: "discarded", summary: preview.summary }]);
    closePreview();
  };

  const applyModelAccess = async (): Promise<boolean> => {
    const access = getActiveModelAccess();
    const applied = await client().setModelAccess(prepareWorkerModelAccess(
      access, access.provider === "clay" ? getSessionToken(access.backendUrl) : null,
      isAmbientSessionAllowed(access.backendUrl),
    ));
    if (applied) setHasKey(hasModelAccess());
    return applied;
  };

  const publishCurrentModelAccess = (): void => {
    const access = getActiveModelAccess();
    publishHostedAccountChange(access.backendUrl ?? window.location.origin,
      hasModelAccess() ? "granted" : "revoked");
  };

  const selectModelProvider = async (provider: ModelProviderId): Promise<void> => {
    authFence.invalidate();
    setModelProvider(provider);
    setModelProviderState(provider);
    if (!await applyModelAccess()) return;
    publishCurrentModelAccess();
    if (provider !== "clay") { setAccount(null); setMeter(null); }
    pushToast(`Model connection: ${provider === "codex" ? "Local Codex" : provider}`, "success");
  };

  const saveKey = async (key: string): Promise<void> => {
    authFence.invalidate();
    setApiKey(key || null);
    setModelProvider("anthropic");
    setModelProviderState("anthropic");
    if (!await applyModelAccess()) return;
    publishCurrentModelAccess();
    pushToast("Anthropic key saved on this device — used by all your apps", "success");
  };

  const saveBackend = async (url: string): Promise<void> => {
    try {
      const normalized = url ? normalizeBackendUrl(url) : null;
      authFence.invalidate();
      setBackendUrl(normalized);
      if (!await applyModelAccess()) return;
      publishCurrentModelAccess();
      pushToast(normalized ? "Model backend set for all apps" : "Model backend cleared", "success");
    } catch (error) {
      pushToast(error instanceof Error ? error.message : String(error), "danger");
    }
  };

  // Hosted-mode account (Phase 1.2): /me feeds the rail meter and the
  // signed-in identity. Sessions ride a bearer token (cross-origin dev)
  // or the cookie (same-origin deploys). Silent in open/local mode.
  const [meter, setMeter] = useState<{ used: number; quota: number | null } | null>(null);
  const [account, setAccount] = useState<{ email: string } | null>(null);
  const [accountN, setAccountN] = useState(0);   // bump to refetch
  useEffect(() => observeHostedAccountChanges(change => {
    void reconcileHostedAuthEpoch(change.backendOrigin, async epoch => {
      const access = getActiveModelAccess();
      if (access.provider !== "clay" || !access.backendUrl
          || new URL(normalizeBackendUrl(access.backendUrl)).origin !== change.backendOrigin) return;
      authFence.invalidate();
      const worker = workerRef.current;
      if (!worker) return;
      worker.revokeAccountSession();
      if (epoch.state !== "granted") {
        setSessionToken(null, access.backendUrl);
        setAmbientSessionAllowed(false, access.backendUrl);
        setAccount(null); setMeter(null);
        return;
      }
      const applied = await applyModelAccess();
      if (applied) setAccountN(value => value + 1);
    }).catch(() => {
      authFence.invalidate();
      const access = getActiveModelAccess();
      setSessionToken(null, access.backendUrl);
      setAmbientSessionAllowed(false, access.backendUrl);
      workerRef.current?.revokeAccountSession();
      setAccount(null); setMeter(null);
    });
  }), [authFence]);
  useEffect(() => {
    if (phase !== "main") return;
    if (modelProvider !== "clay") { setMeter(null); setAccount(null); return; }
    const url = getBackendUrl();
    if (!url) { setMeter(null); setAccount(null); return; }
    void (async () => {
      try {
        const token = getSessionToken(url);
        const res = await fetch(url.replace(/\/$/, "") + "/me", {
          credentials: isAmbientSessionAllowed(url) ? "include" : "omit",
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) { setMeter(null); setAccount(null); return; }
        const b = await res.json() as {
          email: string; mutations_used: number; quota: number | null };
        setMeter({ used: b.mutations_used, quota: b.quota });
        setAccount({ email: b.email });
      } catch { setMeter(null); setAccount(null); }
    })();
  }, [phase, accountN, modelProvider]);

  // Magic-link sign-in. Email navigation returns a no-cookie fragment; both
  // that landing and dev auto-redeem validate one persisted state before redemption.
  const redeemHostedAuth = async (
    attempt: HostedAuthAttempt, token: string,
  ): Promise<void> => {
    const stillCurrent = (): boolean => authFence.isCurrent(attempt, getActiveModelAccess());
    const session = await redeemHostedAuthAttempt(
      authFence, attempt, token, getActiveModelAccess,
    );
    if (!session) return;
    const committed = await commitHostedAuthAttempt(
      authFence,
      attempt,
      getActiveModelAccess,
      session,
      async () => {
        if (!stillCurrent()) return false;
        const access = getActiveModelAccess();
        return client().setModelAccess(prepareWorkerModelAccess(access, session, false));
      },
      () => {
        setAmbientSessionAllowed(false, attempt.backendUrl);
        setSessionToken(session, attempt.backendUrl);
        publishHostedAccountChange(attempt.backendUrl, "granted");
      },
      logoutHostedBearerSession,
    );
    if (!committed) {
      client().revokeAccountSession();
      return;
    }
    setAccountN(n => n + 1);
    pushToast("Signed in — your reshapes now count against your plan", "success");
  };

  useEffect(() => {
    if (phase !== "main" || !authLanding || !workerRef.current) return;
    setAuthLanding(null);
    void (async () => {
      const persisted = await consumePersistedHostedAuthAttempt(
        authLanding.state, getActiveModelAccess(),
      );
      if (!persisted) {
        pushToast("That sign-in link no longer matches this backend", "danger");
        return;
      }
      const attempt = authFence.resume(persisted);
      try { await redeemHostedAuth(attempt, authLanding.token); }
      catch (error) {
        if (authFence.isCurrent(attempt, getActiveModelAccess()))
          pushToast("Sign-in failed: " + (error as Error).message, "danger");
      }
    })().catch(error => {
      pushToast("Sign-in failed closed: " + (error as Error).message, "danger");
    });
  }, [phase, authLanding]);

  const signIn = async (email: string): Promise<void> => {
    const initialAccess = getActiveModelAccess();
    const url = initialAccess.provider === "clay" ? initialAccess.backendUrl : null;
    if (!url) { pushToast("Set the backend URL first", "danger"); return; }
    let attempt: HostedAuthAttempt;
    try { attempt = await authFence.begin(url); }
    catch (error) {
      pushToast("Sign-in unavailable: " + (error as Error).message, "danger");
      return;
    }
    const stillCurrent = (): boolean => authFence.isCurrent(attempt, getActiveModelAccess());
    try {
      const res = await fetch(attempt.backendUrl + "/auth/magic-link", {
        method: "POST", credentials: "omit", signal: attempt.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, state: attempt.state }),
      });
      if (!stillCurrent()) return;
      if (res.status === 204) {
        pushToast("Check your email for the sign-in link", "success");
        return;
      }
      const body = await res.json() as { link?: string; error?: string };
      if (!stillCurrent()) return;
      if (!res.ok || !body.link) {
        pushToast(body.error ?? "Could not send the link", "danger");
        return;
      }
      const callbackUrl = new URL(body.link, `${attempt.backendUrl}/`);
      const token = callbackUrl.searchParams.get("token") ?? "";
      const state = callbackUrl.searchParams.get("state") ?? "";
      if (callbackUrl.origin !== new URL(attempt.backendUrl).origin
          || [...callbackUrl.searchParams.keys()].length !== 2
          || !/^[A-Za-z0-9_-]{32,256}$/.test(token) || state !== attempt.state)
        throw new Error("Sign-in callback did not match the requested backend and state");
      if (!await consumePersistedHostedAuthAttempt(
        attempt.state, getActiveModelAccess(),
      )) return;
      await redeemHostedAuth(attempt, token);
    } catch (e) {
      if (!stillCurrent()) return;
      pushToast("Sign-in failed: " + (e as Error).message, "danger");
    }
  };
  const signOut = async (): Promise<void> => {
    authFence.invalidate();
    const backend = getActiveModelAccess().backendUrl;
    let session: string | null = null;
    const clearLocalAuthorization = (): string | null => {
      const current = getSessionToken(backend);
      setSessionToken(null);
      setAmbientSessionAllowed(false, backend);
      client().revokeAccountSession();
      if (backend) publishHostedAccountChange(backend, "revoked");
      setAccount(null); setMeter(null); setAccountN(n => n + 1);
      return current;
    };
    let globallyOrdered = !backend;
    if (backend) {
      try {
        session = await advanceHostedAuthRevocation(
          backend, () => clearLocalAuthorization(),
        );
        globallyOrdered = true;
      } catch {
        session = clearLocalAuthorization();
      }
    } else {
      session = clearLocalAuthorization();
    }
    pushToast(globallyOrdered
      ? "Signed out on this device"
      : "Signed out locally; cross-tab revocation could not be recorded", globallyOrdered
      ? "default" : "danger");
    if (backend) {
      try { await logoutHostedSession(backend, session); }
      catch { /* local revocation already completed */ }
    }
  };

  const head = history.length > 0 ? history[history.length - 1]!.version : 0;
  const {
    lensId, lenses, lensPanels, lensReady, selectLens, resetLens,
    saveCurrentLens, removeSavedLens,
  } = useLensController({
    ready: phase === "main", appId: currentId ?? currentAppId() ?? "default",
    client: workerRef.current, panels, provenance: panelProvenance, head,
    notify: pushToast,
    onLensChanged: id => recordPrivateMetric({
      type: "lens_changed", mode: id === "all" ? "all" : "situational",
    }),
  });

  const scrubTo = async (version: number): Promise<void> => {
    if (version >= head) { setScrub(null); return; }
    const panelsAt = await client().panelsAt(version);
    setScrub({ version, panels: panelsAt });
  };

  const restoreTo = async (
    version: number, source: "trust_receipt" | "history" | "time_slider" = "history",
  ): Promise<void> => {
    if (busy || preview) {
      pushToast("Keep or discard the open change before rewinding.", "default");
      return;
    }
    if (version >= head) return;
    const dropped = history.filter(h => h.version > version).length;
    const depth = dropped <= 1 ? "one" : dropped <= 5 ? "two_to_five" : "six_plus";
    if (!(await askConfirm(
      `Rewind your app to v${version}? The ${dropped} newer change${dropped === 1 ? "" : "s"} `
      + `will be removed from history. Data rows are always kept.`))) {
      recordPrivateMetric({ type: "rewind_finished", source, result: "cancelled", depth });
      recordPrivateMetric({ type: "recovery_finished",
        method: "history_rewind", result: "discarded" });
      return;
    }
    try {
      await client().makeLatest(version, mutationContext());
      setScrub(null);
      await refreshPanels();
      setFeed(f => [...pruneFeedAfterVersion(f, version),
        { kind: "info", text: `Rewound — v${version} is the latest again.` }]);
      recordPrivateMetric({ type: "rewind_finished", source, result: "success", depth });
      recordPrivateMetric({ type: "recovery_finished",
        method: "history_rewind", result: "success" });
    } catch (error) {
      recordPrivateMetric({ type: "rewind_finished", source, result: "failed", depth });
      recordPrivateMetric({ type: "recovery_finished",
        method: "history_rewind", result: "failed" });
      pushToast(error instanceof Error ? error.message : String(error), "danger");
    }
  };
  restoreToRef.current = restoreTo;
  const makeLatest = async (): Promise<void> => {
    if (scrub) await restoreTo(scrub.version, "time_slider");
  };

  const resetApp = async (): Promise<void> => {
    if (!(await askConfirm(
      "Start a new app? Your existing apps and their data will be kept. "
      + "Choose a blank app or starter next; you can switch back at any time."))) return;
    newApp();
  };

  const removeSamples = async (): Promise<void> => {
    const result = await client().removeSamples(mutationContext());
    liveBridge?.notifyWrite("items");
    for (const p of panels)
      for (const q of p.declared_queries) liveBridge?.notifyWrite(q.from);
    pushToast(result.affected === 0
      ? "No active sample rows to remove"
      : `${result.affected} sample row${result.affected === 1 ? "" : "s"} removed; recoverable`, "success");
  };

  // Scrub takes precedence (read-only render at K); otherwise S5 merging:
  // proposed panels render in place (dashed), removals are ghosted.
  const display = useMemo(() => {
    if (scrub) {
      return scrub.panels.map(panel => ({ panel, isPreview: false, ghost: false }));
    }
    const removed = new Set(preview?.removePanels ?? []);
    const proposedIds = new Set((preview?.panels ?? []).map(p => p.panel_id));
    const items: { panel: LivePanel; isPreview: boolean; ghost: boolean }[] = [];
    for (const p of panels) {
      if (proposedIds.has(p.panel_id)) continue;
      items.push({ panel: p, isPreview: false, ghost: removed.has(p.panel_id) });
    }
    for (const p of preview?.panels ?? [])
      items.push({ panel: p, isPreview: true, ghost: false });
    return items.sort((a, b) =>
      a.panel.placement.order - b.panel.placement.order
      || a.panel.panel_id.localeCompare(b.panel.panel_id));
  }, [panels, preview, scrub]);

  const visibleDisplay = useMemo(() => {
    if (preview || scrub) return display;
    const byId = new Map(display.map(item => [item.panel.panel_id, item]));
    return lensPanels.flatMap(panel => {
      const item = byId.get(panel.panel_id);
      return item ? [{ ...item, panel }] : [];
    });
  }, [display, lensPanels, preview, scrub]);
  const confirmDialog = confirmBox ? (
    <ModalDialog role="alertdialog" className="confirm-card"
      backdropClassName="confirm-backdrop" ariaLabelledBy="confirm-title"
      ariaDescribedBy="confirm-message" onClose={() => settleConfirm(false)}>
      <h2 id="confirm-title" className="confirm-title">Confirm action</h2>
      <p id="confirm-message" className="confirm-msg">{confirmBox.msg}</p>
      <div className="rail-actions confirm-actions">
        <button autoFocus className="primary" onClick={() => settleConfirm(true)}>Confirm</button>
        <button onClick={() => settleConfirm(false)}>Cancel</button>
      </div>
    </ModalDialog>
  ) : null;
  const provenanceById = useMemo(
    () => new Map(panelProvenance.map(item => [item.panel_id, item])),
    [panelProvenance],
  );

  if (phase === "loading") return <div className="boot">Opening your app…</div>;
  if (phase === "error")
    return (<>
      <div className="boot boot-error">
        <h2>This app didn’t open</h2>
        <p className="boot-error-msg">{bootError}</p>
        <div className="rail-actions">
          <button className="primary" onClick={() => window.location.reload()}>Try again</button>
        </div>
        <p className="boot-error-hint">
          Your stored apps were kept. Switching and deleting are unavailable until
          the authoritative catalog opens successfully. Close any other Clay tab,
          then try again; do not clear this site's storage.
        </p>
      </div>
      {confirmDialog}
    </>);
  if (phase === "onboarding")
    return (
      <>
        <Onboarding
          onPick={id => void pickShell(id)}
          onImport={file => void reviewNewAppImport(file)}
          busy={busy}
          error={onboardingError}
          onCancel={!firstRunOnboarding.current && listApps().length > 0
            ? () => {
              if (readAppSetup(sessionStorage)) {
                setOnboardingError("Finish reconciling the pending setup before returning to the app. No app was deleted.");
                return;
              }
              setPhase("main");
            } : undefined}
        />
        {pendingImport ? (
          <ImportReview
            fileName={pendingImport.fileName}
            parsed={pendingImport.parsed}
            busy={busy}
            error={onboardingError}
            onHeaderChange={choice => {
              if (readAppSetup(sessionStorage)) {
                setOnboardingError("This import was already submitted. Retry its original reviewed payload before changing the header.");
                return;
              }
              const reviewed = pendingImport;
              if (!reviewed.parsed.headerReview) return;
              void import("./new-app-import").then(({ reviewParsedNewAppRows }) => {
                try {
                  setPendingImport({ ...reviewed, parsed: reviewParsedNewAppRows(
                    reviewed.fileName, reviewed.parsed.headerReview!.sourceRows, choice,
                  ) });
                  setOnboardingError(null);
                } catch (error) { setOnboardingError(error instanceof Error ? error.message : String(error)); }
              });
            }}
              onCancel={() => {
                if (readAppSetup(sessionStorage)) {
                  setOnboardingError("This import may already be committed. Reload and retry to reconcile its receipt; no app was deleted.");
                  return;
                }
              setPendingImport(null);
              setOnboardingError(null);
            }}
            onConfirm={() => void importNewApp()}
          />
        ) : null}
        {confirmDialog}
      </>
    );

  // Direct manipulation (B4): drag a panel by its grip to rearrange. Each
  // drop is a reversible commit — same timeline as language reshapes. Only
  // live (non-preview, non-scrub) panels are draggable.
  const canDrag = !scrub && !preview && busy === false;
  const applyLayout = async (placements: ReturnType<typeof reorder>): Promise<void> => {
    setDragId(null);
    const updated = await client().commitLayout(placements, mutationContext());
    setPanels(updated);
    setHistory(await client().history());
    await refreshProvenance();
    pushToast("Rearranged — rewind any time in the timeline", "success");
  };
  // Resize (B4/ADR-017): toggle a panel between 1 and 2 columns — a
  // reversible commit, same timeline as everything else.
  // default span: full strip in top, half in main (ADR-022a)
  const defaultW = (p: LivePanel): number => (p.placement.region === "top" ? 4 : 2);
  const setSize = async (panelId: string, dim: { w?: number; h?: number }): Promise<void> => {
    const p = panels.find(x => x.panel_id === panelId);
    if (!p) return;
    if (dim.w !== undefined && (p.placement.w ?? defaultW(p)) === dim.w) return;
    if (dim.h !== undefined && p.placement.h === dim.h) return;
    const updated = await client().commitLayout(
      [{ panel_id: panelId, region: p.placement.region, order: p.placement.order, ...dim }],
      mutationContext(),
    );
    setPanels(updated);
    setHistory(await client().history());
    await refreshProvenance();
  };
  const toggleWidth = (panelId: string): Promise<void> => {
    const p = panels.find(x => x.panel_id === panelId);
    const cur = p ? (p.placement.w ?? defaultW(p)) : 2;
    return setSize(panelId, { w: cur >= 3 ? 2 : 4 });   // toggle half <-> full
  };

  // Small changes never call the model (ADR-022c): rename and remove are
  // instant local commits on the same timeline as language reshapes.
  const renamePanelLocal = async (panelId: string, title: string): Promise<void> => {
    const updated = await client().renamePanel(panelId, title, mutationContext());
    setPanels(updated);
    setHistory(await client().history());
    await refreshProvenance();
  };
  const removePanelLocal = async (panelId: string): Promise<void> => {
    const title = panels.find(p => p.panel_id === panelId)?.title ?? panelId;
    if (!(await askConfirm(
      `Remove “${title}”? Your data is untouched — rewind the timeline to bring the panel back.`))) return;
    const updated = await client().removePanel(panelId, mutationContext());
    setPanels(updated);
    setHistory(await client().history());
    await refreshProvenance();
    pushToast("Panel removed — rewind any time in the timeline", "success");
  };
  // Point, then speak (ADR-022d): seed the composer scoped to one panel.
  const askAboutPanel = (panel: LivePanel): void => {
    setIntentSeed(s => ({ text: `In the “${panel.title}” panel: `, n: s.n + 1 }));
    setRailOpen(true);
    try { localStorage.setItem("clay_reshape_open", "true"); } catch { /* private mode */ }
  };

  const toggleRail = (): void => {
    setRailOpen(open => {
      const next = !open;
      try { localStorage.setItem("clay_reshape_open", String(next)); } catch { /* private mode */ }
      return next;
    });
  };

  const receiptOpened = (): void => {
    recordPrivateMetric({ type: "trust_surface_opened", surface: "trust_receipt" });
    if (!proofLoopRecorded.current && firstKeepAt.current !== null) {
      proofLoopRecorded.current = true;
      recordPrivateMetric({ type: "proof_loop_completed",
        elapsed: durationBucket(Date.now() - firstKeepAt.current) });
    }
  };

  const openPrivateMetrics = async (): Promise<void> => {
    recordPrivateMetric({ type: "trust_surface_opened", surface: "storage_status" });
    setPrivateMetricsSummary(await client().privateMetricsSummary());
    setShowPrivateMetrics(true);
  };

  const setPrivateMetricsEnabled = async (enabled: boolean): Promise<boolean> => {
    try {
      setPrivateMetricsSummary(await client().setPrivateMetricsEnabled(
        enabled, mutationContext()));
      return true;
    } catch (error) {
      pushToast(error instanceof Error ? error.message : String(error), "danger");
      return false;
    }
  };

  const clearPrivateMetrics = async (): Promise<boolean> => {
    try {
      setPrivateMetricsSummary(await client().clearPrivateMetrics(mutationContext()));
      return true;
    } catch (error) {
      pushToast(error instanceof Error ? error.message : String(error), "danger");
      return false;
    }
  };

  const copyPrivateMetrics = async (): Promise<boolean> => {
    if (!privateMetricsSummary) return false;
    const summary = {
      ...privateMetricsSummary,
      reshape: {
        ...privateMetricsSummary.reshape,
        discardByDiff: privateMetricsSummary.reshape.discardByDiff
          .filter(item => item.decisions >= 3),
      },
      recovery: {
        ...privateMetricsSummary.recovery,
        byMethod: privateMetricsSummary.recovery.byMethod
          .filter(item => item.completed >= 3),
      },
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(summary, null, 2));
      return true;
    } catch {
      return false;
    }
  };

  const openHistory = (): void => {
    rememberSurfaceReturnFocus();
    recordPrivateMetric({ type: "trust_surface_opened", surface: "history" });
    setShowHistory(true);
  };
  const closeHistory = (): void => {
    setShowHistory(false);
    restoreSurfaceFocus();
  };

  const openShapeMap = async (): Promise<void> => {
    recordPrivateMetric({ type: "trust_surface_opened", surface: "shape_map" });
    try { setRegistryTables(await client().registryTables()); } catch { /* keep last known shape */ }
    setShowData(false);
    setShowHistory(false);
    setShowShapeMap(true);
  };

  // View switcher (moat pillar 4): re-lens one panel's data as a different
  // view via a targeted reshape (previewed + reversible like any change).
  const viewAs = (panel: LivePanel, view: string): void => {
    const table = panel.declared_queries[0]?.from;
    const subject = table ? `my ${table}` : `the “${panel.title}” data`;
    const intents: Record<string, string> = {
      table: `Change the “${panel.title}” panel to a sortable table of ${subject}.`,
      board: `Change the “${panel.title}” panel to a board of ${subject} grouped by its status.`,
      cards: `Change the “${panel.title}” panel to a grid of cards for ${subject}.`,
      chart: `Change the “${panel.title}” panel to a chart summarising ${subject}.`,
      timeline: `Change the “${panel.title}” panel to a timeline of ${subject} by date.`,
    };
    const intent = intents[view];
    if (intent) void runIntent(intent);
  };

  // Reading-order drop index: insert before the first panel the cursor sits
  // above (earlier row) or left-of-centre within (same row). Works for the
  // flex regions and the 2-col main grid alike.
  const dropIndexAt = (container: Element, x: number, y: number): number => {
    const frames = [...container.querySelectorAll(".panel-frame")];
    for (let i = 0; i < frames.length; i++) {
      const r = frames[i]!.getBoundingClientRect();
      if (y < r.top) return i;
      if (y <= r.bottom && x < r.left + r.width / 2) return i;
    }
    return frames.length;
  };

  // In the 4-col main region, snap to a start column (ADR-019), clamped so the
  // dragged panel's width fits. Elsewhere col is null (auto-flow).
  const colAt = (regionName: Region, container: Element, x: number): number | null => {
    if (regionName !== "main") return null;
    const r = container.getBoundingClientRect();
    const w = panels.find(p => p.panel_id === dragId)?.placement.w ?? 2;
    const raw = Math.floor((x - r.left) / (r.width / 4));
    return Math.max(0, Math.min(raw, 4 - w));
  };

  const onRegionDragOver = (regionName: Region, e: React.DragEvent): void => {
    if (!dragId) return;
    e.preventDefault();
    const index = dropIndexAt(e.currentTarget, e.clientX, e.clientY);
    const col = colAt(regionName, e.currentTarget, e.clientX);
    setDropTarget(prev =>
      prev && prev.region === regionName && prev.index === index && prev.col === col
        ? prev : { region: regionName, index, col });
  };

  const onRegionDrop = (regionName: Region, e: React.DragEvent): void => {
    if (!dragId) return;
    e.preventDefault();
    const index = dropIndexAt(e.currentTarget, e.clientX, e.clientY);
    const col = colAt(regionName, e.currentTarget, e.clientX);
    setDropTarget(null);
    void applyLayout(reorder(panels, dragId, regionName, index, col ?? undefined));
  };

  const region = (name: "top" | "main" | "side"): React.JSX.Element[] => {
    const canArrange = canDrag && lensId === "all" && workspaceMode === "customize";
    const els = visibleDisplay
      .filter(d => d.panel.placement.region === name)
      .map(d => {
        const bridge = d.isPreview ? shadowBridge : liveBridge;
        if (!bridge || d.ghost) {
          return (
            <section key={d.panel.panel_id} className="panel-frame panel-ghost">
              <header className="panel-title">{d.panel.title}
                <span className="panel-proposed">will be removed</span>
              </header>
            </section>
          );
        }
        const loadingStyle: React.CSSProperties = {
          minHeight: (d.panel.placement.h ?? 180) + 54,
        };
        if (name !== "side") {
          const span = d.panel.placement.w ?? (name === "top" ? 4 : 2);
          const col = d.panel.placement.col;
          loadingStyle.gridColumn = col == null ? `span ${span}` : `${col + 1} / span ${span}`;
          loadingStyle.gridRow = `span ${(d.panel.placement.h ?? 180) + 72}`;
        }
        return (
          <Suspense
            key={`${d.panel.panel_id}@${d.panel.version}${d.isPreview ? ":preview" : ""}:t${themeId}`}
            fallback={<section className="panel-frame panel-loading" style={loadingStyle}>
              <header className="panel-title">Opening {d.panel.title}…</header>
            </section>}
          >
          <PanelFrame
            panel={d.panel}
            provenance={workspaceMode === "customize" && !d.isPreview && !scrub
              ? provenanceById.get(d.panel.panel_id) : undefined}
            bridge={bridge}
            themeCss={themeCss}
            preview={d.isPreview}
            fault={faults[d.panel.panel_id]}
            onRepair={!busy && !d.isPreview ? (): void => void repairPanel(d.panel.panel_id) : undefined}
            onRevert={d.isPreview ? undefined : (): void => void revertPanel(d.panel.panel_id)}
            onDismiss={(): void => dismissFault(d.panel.panel_id)}
            onDragStart={canArrange && !d.isPreview ? setDragId : undefined}
            onDragEnd={(): void => { setDragId(null); setDropTarget(null); }}
            draggingSrc={dragId === d.panel.panel_id}
            wide={(d.panel.placement.w ?? (d.panel.placement.region === "top" ? 4 : 2)) >= 3}
            onResize={canArrange && !d.isPreview && d.panel.placement.region !== "side"
              ? (): void => void toggleWidth(d.panel.panel_id) : undefined}
            onSetWidth={canArrange && !d.isPreview && d.panel.placement.region !== "side"
              ? (w): void => void setSize(d.panel.panel_id, { w }) : undefined}
            onSetHeight={canArrange && !d.isPreview
              ? (h): void => void setSize(d.panel.panel_id, { h }) : undefined}
            onViewAs={workspaceMode === "customize" && canDrag && !d.isPreview
              && d.panel.declared_queries.length > 0
              ? (view): void => viewAs(d.panel, view) : undefined}
            onEditData={workspaceMode === "customize" && !d.isPreview
              ? (table): void => openData(table) : undefined}
            onRename={workspaceMode === "customize" && canDrag && !d.isPreview
              ? (title): void => void renamePanelLocal(d.panel.panel_id, title) : undefined}
            onRemove={workspaceMode === "customize" && canDrag && !d.isPreview
              ? (): void => void removePanelLocal(d.panel.panel_id) : undefined}
            onAskAbout={workspaceMode === "customize" && !d.isPreview
              ? (): void => askAboutPanel(d.panel) : undefined}
          />
          </Suspense>
        );
      });
    // a clear placeholder marking exactly where the dragged panel will land —
    // in the target column, at the dragged panel's width (2D snap, ADR-019)
    if (dragId && dropTarget && dropTarget.region === name) {
      const i = Math.max(0, Math.min(dropTarget.index, els.length));
      const dw = panels.find(p => p.panel_id === dragId)?.placement.w ?? 2;
      const slotStyle = name === "main" && dropTarget.col !== null
        ? { gridColumn: `${dropTarget.col + 1} / span ${dw}` } : undefined;
      els.splice(i, 0, <div key="drop-slot" className="drop-slot" style={slotStyle} aria-hidden="true" />);
    }
    return els;
  };

  return (
    <div className={`app${dragId ? " app-dragging" : ""}`}>
      <AppSwitcher
        apps={apps}
        currentId={currentId}
        onSwitch={id => { void switchApp(id); }}
        onNew={newApp}
        onFork={() => void forkApp()}
        onRename={(id, name) => { void renameCurrentApp(id, name); }}
        onDelete={id => void deleteApp(id)}
        onOpenSearch={() => openCommandPalette(false)}
        onOpenAutomations={() => openAutomations()}
        onOpenIntake={() => setShowIntake(true)}
        unreadNotifications={notifications.filter(notification => !notification.read).length}
        onOpenData={() => openData()}
        onOpenShapeMap={() => void openShapeMap()}
        railOpen={railOpen}
        onToggleRail={toggleRail}
        version={head}
        persistent={persistent}
        onOpenRecovery={openRecoveryCenter}
        themes={THEMES}
        themeId={themeId}
        onSelectTheme={selectTheme}
        lenses={lenses}
        lensId={lensId}
        lensReady={lensReady}
        onSelectLens={selectLens}
        onSaveLens={saveCurrentLens}
        onDeleteLens={removeSavedLens}
        workspaceMode={workspaceMode}
        onWorkspaceModeChange={chooseWorkspaceMode}
      />
      {(firstSuccessLoading || firstSuccessError
          || firstSuccess?.start.state === "complete") ? (
        <LazySurfaceBoundary label="first steps">
          <Suspense fallback={<SurfaceFallback label="first steps" />}>
            <FirstSuccessChecklist
              state={firstSuccess}
              loading={firstSuccessLoading}
              error={firstSuccessError}
              persistent={persistent}
              protection={deviceProtectionState}
              onAddRecord={() => {
                chooseWorkspaceMode("work");
                setShowCommandPalette(true);
              }}
              onDoEveryday={() => void startEverydayAction()}
              onAskClay={() => {
                chooseWorkspaceMode("customize");
                setRailOpen(true);
                try { localStorage.setItem("clay_reshape_open", "true"); }
                catch { /* presentation only */ }
                seedIntent("Add one useful summary to this app.");
              }}
              onReviewPreview={() => {
                chooseWorkspaceMode("customize");
                setRailOpen(true);
                try { localStorage.setItem("clay_reshape_open", "true"); }
                catch { /* presentation only */ }
                if (!preview) seedIntent("Add one useful summary to this app.");
              }}
              onDismiss={() => void updateFirstSuccess({ type: "set_dismissed", dismissed: true })}
              onResume={() => void updateFirstSuccess({ type: "set_dismissed", dismissed: false })}
              onRetry={() => {
                if (workerRef.current) void loadFirstSuccess(workerRef.current);
              }}
            />
          </Suspense>
        </LazySurfaceBoundary>
      ) : null}
      {showRecoveryCenter ? (
        <LazySurfaceBoundary label="Recovery Center" modal>
          <Suspense fallback={<SurfaceFallback label="Recovery Center" modal />}>
            <RecoveryCenter
              appName={apps.find(app => app.id === currentId)?.name ?? "This app"}
              authoritativeAppInstanceId={currentId}
              opfsAvailable={persistent}
              backupTrustStatus={backupTrustStatus}
              backupAdapterStatus={backupAdapterStatus}
              backupTarget={backupTarget ? {
                targetId: backupTarget.target.targetId,
                folderName: backupTarget.folderName,
              } : null}
              lastVerifiedBackup={backupHistory.find(record => record.availability !== "absent"
                && record.targetId === backupTarget?.target.targetId) ?? null}
              failures={backupFailures}
              history={backupHistory}
              retentionWork={backupRetentionWork}
              onResumeRetention={resumeBackupRetention}
              structuralHistory={history}
              recentBatches={recoveryBatches}
              recordCandidates={recoveryRecords}
              recoveryFailures={recoveryActionFailures}
              importedVerifierSeriesId={importedVerifierSeriesId}
              onClose={() => setShowRecoveryCenter(false)}
              onRetry={backupTarget && backupFailures.length > 0 ? retryBackup : undefined}
              onRetryBackupAdapter={backupAdapterStatus === "error" ? retryBackupAdapter : undefined}
              onChooseFolder={backupAdapterAvailable ? chooseBackupFolder : undefined}
              onExportRecoveryKit={exportRecoveryKit}
              onConfirmRecoveryKit={confirmRecoveryKit}
              onImportRecoveryKit={importRecoveryKit}
              onActivateImportedSeries={activateImportedBackupSeries}
              onRestoreRecord={restoreRecoveryRecord}
              onUndoBatch={undoRecoveryBatch}
              onRewindStructure={rewindRecoveryStructure}
              onValidateRestore={productionWorkerRouteAvailable("validateRestoreArchive") ? validateRestore : undefined}
              manualDownloads={manualDownloads}
              pendingManualDownload={pendingDownloadRecord}
              onResumeManualDownload={resumeManualDownload}
              onDiscardManualDownload={discardManualDownload}
              onRetireBackup={async (seriesId, backupId) => {
                if (!(await askConfirm("Retire this unfinished backup attempt? All existing files will be kept. An already published backup cannot be retired here.")))
                  throw new Error("Backup retirement cancelled; existing files kept.");
                await client().retireAutomaticBackup(seriesId, backupId, "keep_existing_files_and_retire_unpublished_attempt");
                await refreshRecoveryState();
              }}
              onRestoreAsNew={productionWorkerRouteAvailable("restoreAsNew") ? restoreAsNew : undefined}
            />
          </Suspense>
        </LazySurfaceBoundary>
      ) : null}
      {!persistent ? (
        <div className="banner">
          <span>
            Your data isn’t saving on this device right now. If Clay is open in
            another tab, close it and retry. Otherwise export a backup to be safe.
          </span>
          <span className="banner-actions">
            <button className="link" onClick={reloadApp}>Retry</button>
            <button className="link" onClick={() => void exportArchive()}>Export backup</button>
          </span>
        </div>
      ) : null}
      <div className="app-body">
      {workspaceMode === "work" && workerRef.current ? (
        <LazySurfaceBoundary label="Today">
          <Suspense fallback={<SurfaceFallback label="Today" />}>
            <TodayView
              worker={workerRef.current}
              tables={registryTables}
              refreshToken={dailyRefresh}
              onOpenRecord={(table, id) => openData(table, id)}
              onOpenAutomation={id => openAutomations(undefined, id)}
              onOpenSavedView={id => openData(undefined, undefined, id)}
              onQuickCapture={() => openCommandPalette(true)}
              onSetup={() => openData()}
              onCreateRecurring={() => openAutomations("recurring_record")}
              automationMutationsAvailable={automationStorageAvailable}
              dailyHomeMutationsAvailable
              onWrite={table => { liveBridge?.notifyWrite(table); invalidateDailyHome(); }}
              onError={message => pushToast(message, "danger")}
            />
          </Suspense>
        </LazySurfaceBoundary>
      ) : <>
      <LazySurfaceBoundary label="views">
      <main className="regions">
        <TimeSlider
          history={history}
          current={scrub?.version ?? head}
          scrubbed={scrub !== null}
          disabled={busy || preview !== null}
          onScrub={v => void scrubTo(v)}
          onMakeLatest={() => void makeLatest()}
          onOpenHistory={openHistory}
        />
        {display.length === 0 && !preview && !scrub ? (
          <div className="empty-canvas">
            {workspaceMode === "work" ? <>
              <div className="empty-canvas-spark" aria-hidden="true">✓</div>
              <h2>Your workspace is ready</h2>
              <p>Use Search to find or update work. Switch to Customize when you want to
                add views, import data, or reshape the workspace.</p>
              <button className="empty-chip" onClick={() => chooseWorkspaceMode("customize")}>
                Customize workspace
              </button>
            </> : <>
            <div className="empty-canvas-spark">✦</div>
            <h2>What do you want to build?</h2>
            <p>Describe it in plain words. Every proposed change is reviewed before it is applied,
              and every kept change remains reversible.</p>
            <div className="empty-canvas-chips">
              {[
                "Build a habit tracker with a daily check-off and a streak count",
                "A simple client CRM with contacts and a deal pipeline board",
                "A reading list with a shelf of book cards and a rating",
                "A weekly meal planner with a board by day of the week",
                "An expense tracker with a category chart and a running total",
              ].map(ex => (
                <button key={ex} className="empty-chip" disabled={busy}
                  onClick={() => seedIntent(ex)}>{ex}</button>
              ))}
            </div>
            {busy ? <p className="empty-canvas-busy">Building…</p> : null}
            </>}
          </div>
        ) : (
          <>
            <div className="region-top" onDragOver={e => onRegionDragOver("top", e)} onDrop={e => onRegionDrop("top", e)}>{region("top")}</div>
            <div className="region-main" onDragOver={e => onRegionDragOver("main", e)} onDrop={e => onRegionDrop("main", e)}>{region("main")}</div>
            <div className="region-side" onDragOver={e => onRegionDragOver("side", e)} onDrop={e => onRegionDrop("side", e)}>{region("side")}</div>
          </>
        )}
      </main>
      </LazySurfaceBoundary>
      </>}
      {showHistory ? (
        <LazySurfaceBoundary label="history" modal>
        <Suspense fallback={<SurfaceFallback label="history" modal />}>
        <HistoryView
          history={history}
          head={head}
          current={scrub?.version ?? head}
          onJump={v => { void scrubTo(v); closeHistory(); }}
          onRestore={v => void restoreTo(v)}
          onSetCheckpoint={(v, label) => void client()
            .setCheckpoint(v, label, mutationContext()).then(setHistory)}
          onClose={closeHistory}
        />
        </Suspense>
        </LazySurfaceBoundary>
      ) : null}
      {showAutomations && workerRef.current ? (
        <LazySurfaceBoundary label="automations" modal>
          <Suspense fallback={<SurfaceFallback label="automations" modal />}>
            <AutomationCenter
              worker={workerRef.current}
              tables={registryTables}
              notifications={notifications}
              initialRecipe={automationRecipe}
              initialAutomationId={automationTargetId}
              appInstanceId={currentId}
              schedulerWaitReason={automationWaitReason}
              onNotifications={setNotifications}
              onClose={() => {
                setShowAutomations(false);
                setAutomationRecipe(undefined);
                setAutomationTargetId(undefined);
              }}
              onOpenRecord={(table, id) => openData(table, id)}
              onWrite={table => { liveBridge?.notifyWrite(table); invalidateDailyHome(); }}
              onError={message => pushToast(message, "danger")}
              onInfo={message => pushToast(message, "info")}
              onConfirm={askConfirm}
            />
          </Suspense>
        </LazySurfaceBoundary>
      ) : null}
      {showIntake && workerRef.current && semanticTrace && currentId ? (
        <LazySurfaceBoundary label="public intake" modal>
          <Suspense fallback={<SurfaceFallback label="public intake" modal />}>
            <IntakeCenter
              worker={workerRef.current}
              appInstanceId={currentId}
              tables={registryTables}
              semanticTrace={semanticTrace}
              relayBaseUrl={getRelayOwnerUrl()}
              publicBaseUrl={location.origin}
              onClose={() => setShowIntake(false)}
              onWrite={() => {
                for (const table of registryTables) liveBridge?.notifyWrite(table.name);
              }}
              onError={message => pushToast(message, "danger")}
              onInfo={message => pushToast(message, "info")}
            />
          </Suspense>
        </LazySurfaceBoundary>
      ) : null}
      {showCommandPalette && workerRef.current && dataStoreRef.current ? (
        <LazySurfaceBoundary label="search and act" modal>
          <Suspense fallback={<SurfaceFallback label="search and act" modal />}>
            <CommandPalette
              appInstanceId={currentId}
              worker={workerRef.current}
              store={dataStoreRef.current}
              tables={registryTables}
              captureMode={quickCaptureMode}
              onClose={() => { setShowCommandPalette(false); setQuickCaptureMode(false); }}
              onOpenRecord={(table, id) => openData(table, id)}
              onOpenData={table => openData(table)}
              onWrite={table => {
                liveBridge?.notifyWrite(table);
                invalidateDailyHome();
                void refreshFirstRunEvidence(workerRef.current!);
              }}
              onError={message => pushToast(message, "danger")}
              onInfo={(message, action) => pushToast(message, "info", action)}
            />
          </Suspense>
        </LazySurfaceBoundary>
      ) : null}
      {showData && dataStoreRef.current && workerRef.current ? (
        <LazySurfaceBoundary label="data" modal>
        <Suspense fallback={<SurfaceFallback label="data" modal />}>
        <DataView
          worker={workerRef.current}
          store={dataStoreRef.current}
          appInstanceId={currentId}
          initialTable={dataTable}
          initialRecordId={dataRecord}
          initialSavedViewId={dataSavedView}
          returnFocusRef={surfaceReturnFocus}
          onWrite={table => {
            liveBridge?.notifyWrite(table);
            invalidateDailyHome();
            void refreshFirstRunEvidence(workerRef.current!);
          }}
          onDailyHomeInvalidated={invalidateDailyHome}
          onEverydayAction={setFirstSuccess}
          onClose={closeData}
          onError={msg => pushToast(msg, "danger")}
          onInfo={msg => pushToast(msg, "info")}
          onConfirm={askConfirm}
          onSchemaChange={() => void refreshPanels()}
          onRecovery={result => recordPrivateMetric({
            type: "recovery_finished", method: "row_restore", result,
          })}
        />
        </Suspense>
        </LazySurfaceBoundary>
      ) : null}
      {workspaceMode === "customize" && railOpen ? <ConversationRail
        feed={feed}
        preview={preview}
        busy={busy || scrub !== null}
        hasKey={hasKey}
        suggestions={suggestions}
        onAcceptSuggestion={acceptSuggestion}
        onDismissSuggestion={dismissSuggestion}
        loadStatus={() => client().status()}
        seed={intentSeed}
        meter={meter}
        account={account}
        onSignIn={email => void signIn(email)}
        onSignOut={() => void signOut()}
        themes={THEMES}
        themeId={themeId}
        onSelectTheme={selectTheme}
        modelProvider={modelProvider}
        onSelectModelProvider={provider => void selectModelProvider(provider)}
        onIntent={t => void runIntent(t)}
        onKeep={() => void keep()}
        onDiscard={() => void discard()}
        onRewind={version => void restoreTo(version, "trust_receipt")}
        onReceiptOpened={receiptOpened}
        onSaveKey={k => void saveKey(k)}
        onSaveBackend={u => void saveBackend(u)}
        onRemoveSamples={() => void removeSamples()}
        onReset={() => void resetApp()}
        onExport={() => void exportArchive()}
        onPurgeAttachments={async () => {
          const result = await client().purgeDeletedAttachments(mutationContext());
          pushToast(result.files === 0 ? "No removed files are old enough to clean up"
            : `Cleaned up ${result.files} file${result.files === 1 ? "" : "s"}`, "info");
        }}
        onCopyDiagnostics={() => void copyDiagnostics()}
        onOpenPrivateMetrics={() => void openPrivateMetrics()}
      /> : null}
      </div>
      {showShapeMap ? (
        <LazySurfaceBoundary label="shape map" modal>
        <Suspense fallback={<SurfaceFallback label="shape map" modal />}>
        <ShapeMapView
          tables={registryTables}
          panels={panels}
          history={history}
          semanticTrace={semanticTrace}
          fieldProvenance={fieldProvenance}
          persistent={persistent}
          onClose={() => setShowShapeMap(false)}
          onOpenData={table => openData(table)}
          onOpenHistory={openHistory}
          onAskAbout={askAboutPanel}
        />
        </Suspense>
        </LazySurfaceBoundary>
      ) : null}
      {showPrivateMetrics && privateMetricsSummary ? (
        <LazySurfaceBoundary label="private activity" modal>
        <Suspense fallback={<SurfaceFallback label="private activity" modal />}>
          <PrivateMetricsView
            summary={privateMetricsSummary}
            persistent={persistent}
            onClose={() => setShowPrivateMetrics(false)}
            onToggle={setPrivateMetricsEnabled}
            onClear={clearPrivateMetrics}
            onCopy={copyPrivateMetrics}
          />
        </Suspense>
        </LazySurfaceBoundary>
      ) : null}
      {confirmDialog}
      <ModalScopedPortal>
        <div className="toasts" data-modal-scoped-feedback
          aria-live="polite" aria-atomic="true">
          {toasts.map(t => (
            <div key={t.id} className={`toast toast-${t.kind}`}
              role={t.kind === "danger" ? "alert" : "status"}>
              {t.msg}
              {t.action ? (
                <button
                  className="toast-action"
                  onClick={() => { t.action!.run(); setToasts(x => x.filter(y => y.id !== t.id)); }}
                >{t.action.label}</button>
              ) : null}
            </div>
          ))}
        </div>
      </ModalScopedPortal>
    </div>
  );
}
