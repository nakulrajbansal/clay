// The shell chrome (doc 02 §1): onboarding -> main screen with panel
// regions + conversation rail. Live panels bind to the live store's Bridge;
// during S5 the proposed panels render in place with a dashed frame,
// bound to a SECOND Bridge over the shadow store (preview-before-commit).
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bridge, StoreRpcClient, deriveSafeDiffKind, portFromMessagePort,
  type ClayNotification,
  type FieldProvenance, type HistoryEntry, type LivePanel, type PanelProvenance,
  type PrivateMetricEvent, type PrivateMetricsSummary, type RegTable,
  type SemanticSchemaTraceV1, type Suggestion,
} from "@clay/kernel";
import { WorkerClient } from "./worker-client";
import type { IntentOutcome, PreviewInfo } from "../worker/db-worker";
import type { StarterShellId } from "../shells/seed";
import { ConversationRail, pruneFeedAfterVersion, type FeedItem } from "./ConversationRail";
import { Onboarding } from "./Onboarding";
import { TimeSlider } from "./TimeSlider";
import { AppSwitcher } from "./AppSwitcher";
import {
  addForkEntry, createApp, currentApp, currentAppId, deriveAppName, ensureLegacyAdopted,
  listApps, removeApp, renameApp, setCurrentApp, shellName, type AppEntry,
} from "./apps";
import {
  THEMES, applyThemeToRoot, getThemeId, panelThemeCss, setThemeId as saveThemeId, themeById,
} from "./themes";
import {
  getActiveModelAccess, getApiKey, getBackendUrl, getModelProvider,
  getSessionToken, hasModelAccess, normalizeBackendUrl, setApiKey, setBackendUrl, setModelProvider,
  setSessionToken, type ModelProviderId,
} from "./settings";
import { reorder, type Region } from "./layout";
import { parseImportFile } from "./importData";
import { buildTrustReceipt } from "./change-contract";
import { useLensController } from "./useLensController";
import { LazySurfaceBoundary } from "./LazySurfaceBoundary";
import { ModalDialog } from "./ModalDialog";

type Phase = "loading" | "onboarding" | "main" | "error";

const DataView = lazy(() => import("./DataView").then(module => ({ default: module.DataView })));
const CommandPalette = lazy(() => import("./CommandPalette")
  .then(module => ({ default: module.CommandPalette })));
const AutomationCenter = lazy(() => import("./AutomationCenter")
  .then(module => ({ default: module.AutomationCenter })));
const HistoryView = lazy(() => import("./HistoryView").then(module => ({ default: module.HistoryView })));
const PanelFrame = lazy(() => import("./PanelFrame").then(module => ({ default: module.PanelFrame })));
const ShapeMapView = lazy(() => import("./ShapeMapView").then(module => ({ default: module.ShapeMapView })));
const PrivateMetricsView = lazy(() => import("./PrivateMetricsView")
  .then(module => ({ default: module.PrivateMetricsView })));

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

async function wipeOpfsWithoutWorker(): Promise<void> {
  type IterableDirectory = {
    entries: () => AsyncIterableIterator<[string, unknown]>;
    removeEntry: (name: string, options?: { recursive?: boolean }) => Promise<void>;
  };
  const storage = navigator.storage;
  const getDirectory = (storage as unknown as {
    getDirectory?: () => Promise<IterableDirectory>;
  }).getDirectory;
  if (!getDirectory) return;
  const root = await getDirectory.call(storage);
  for await (const [name] of root.entries())
    await root.removeEntry(name, { recursive: true });
}

async function prepareWorkerModelAccess(
  access: ReturnType<typeof getActiveModelAccess>,
  claySession: string | null,
): Promise<ReturnType<typeof getActiveModelAccess> & {
  session: string | null; providerToken?: string | null;
}> {
  let providerToken: string | null = null;
  if (access.provider === "codex" && access.backendUrl) {
    try {
      const response = await fetch(`${access.backendUrl.replace(/\/$/, "")}/healthz`);
      const health = await response.json() as {
        provider?: string; connector_token?: string;
      };
      if (response.ok && health.provider === "codex"
          && typeof health.connector_token === "string"
          && health.connector_token.length >= 32) providerToken = health.connector_token;
    } catch { /* the status surface reports an unreachable connector */ }
  }
  return {
    ...access,
    session: access.provider === "clay" ? claySession : null,
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
      ? (_panel, name, payload) => { void client.recordFilter(name, payload); }
      : undefined,
  }, { allowWrites: target === "live" });
}

export function App(): React.JSX.Element {
  const workerRef = useRef<WorkerClient | null>(null);
  const appReadyAt = useRef(Date.now());
  const activationRecorded = useRef(false);
  const firstKeepAt = useRef<number | null>(null);
  const proofLoopRecorded = useRef(false);
  const pendingRecovery = useRef<RecoveryMethod | null>(null);
  const surfaceReturnFocus = useRef<HTMLElement | null>(null);
  const openRecordRef = useRef<(table: string, id: string) => void>(() => {});
  const restoreToRef = useRef<(version: number) => Promise<void>>(async () => {});
  const [phase, setPhase] = useState<Phase>("loading");
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
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
  const [showAutomations, setShowAutomations] = useState(false);
  const [notifications, setNotifications] = useState<ClayNotification[]>([]);
  const [dataTable, setDataTable] = useState<string | null>(null);
  const [dataRecord, setDataRecord] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showShapeMap, setShowShapeMap] = useState(false);
  const [showPrivateMetrics, setShowPrivateMetrics] = useState(false);
  const [privateMetricsSummary, setPrivateMetricsSummary] = useState<PrivateMetricsSummary | null>(null);
  const [railOpen, setRailOpen] = useState<boolean>(() => {
    try { return localStorage.getItem("clay_reshape_open") !== "false"; }
    catch { return true; }
  });
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

  // Landing after a magic-link email click (backend redirects the browser
  // to /?auth=ok|expired with the session cookie set): confirm or nudge,
  // then clean the URL so a reload doesn't re-toast.
  useEffect(() => {
    try {
      const u = new URL(window.location.href);
      const flag = u.searchParams.get("auth");
      if (!flag) return;
      if (flag === "ok") pushToast("Signed in — welcome back", "success");
      if (flag === "expired")
        pushToast("That sign-in link expired — request a fresh one", "danger");
      u.searchParams.delete("auth");
      window.history.replaceState(null, "", u.toString());
    } catch { /* non-browser context */ }
  }, [pushToast]);

  const client = (): WorkerClient => {
    if (!workerRef.current) throw new Error("worker not ready");
    return workerRef.current;
  };

  useEffect(() => {
    if (phase !== "main" || !workerRef.current) return;
    let live = true;
    let running = false;
    const tick = async (): Promise<void> => {
      if (running || !workerRef.current) return;
      running = true;
      try {
        const [runs, inbox] = await Promise.all([
          workerRef.current.runAutomations(), workerRef.current.notifications(),
        ]);
        if (!live) return;
        setNotifications(inbox);
        if (runs.some(run => run.changed > 0)) {
          for (const table of registryTables) liveBridge?.notifyWrite(table.name);
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
  }, [phase, liveBridge, registryTables, pushToast]);

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
    }).catch(() => undefined);
    setFaults(f => (f[panelId] ? f : { ...f, [panelId]: fault }));
  }, []);

  const refreshPanels = useCallback(async (): Promise<void> => {
    const [nextPanels, nextHistory, nextTables, nextProvenance,
      nextSemanticTrace, nextFieldProvenance] = await Promise.all([
      client().panels(), client().history(), client().registryTables(),
      client().panelProvenance(), client().semanticTrace(), client().fieldProvenance(),
    ]);
    setPanels(nextPanels);
    setHistory(nextHistory);
    setRegistryTables(nextTables);
    setPanelProvenance(nextProvenance);
    setSemanticTrace(nextSemanticTrace);
    setFieldProvenance(nextFieldProvenance);
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
    void client().recordPrivateMetric(event).catch(() => undefined);
  }, []);

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

  // Bring-your-own-data: parse the file in the trusted shell, create the table
  // + rows (one reversible commit), then let the model build the dashboard.
  const importFile = async (file: File): Promise<void> => {
    setBusy(true);
    try {
      const parsed = parseImportFile(await file.text(), file.name);
      if (parsed.columns.length === 0 || parsed.rows.length === 0)
        throw new Error("No rows found — check the file has a header row and data.");
      const res = await client().importTable(
        { table: parsed.table, columns: parsed.columns, rows: parsed.rows });
      await refreshPanels();
      setDataTable(res.table);   // if the Data editor is open, jump to the new table
      setFeed(f => [...f, { kind: "info", text: `Imported ${res.imported} row${res.imported === 1 ? "" : "s"} into “${res.table}”.` }]);
      setBusy(false);
      void refreshSuggestions();
      if (hasKey) {
        void runIntent(`Build the most insightful dashboard for my “${res.table}” data `
          + `(${res.columns} columns): a few key metric cards, one or two charts, and — if there's a `
          + `status/category column — a board grouped by it. Keep the existing table too.`);
      } else {
        setFeed(f => [...f, { kind: "info", text: "Add a model key in settings, then ask me to build a dashboard." }]);
      }
    } catch (e) {
      setBusy(false);
      pushToast("Import failed: " + (e as Error).message, "danger");
    }
  };

  // boot
  useEffect(() => {
    const worker = new Worker(new URL("../worker/db-worker.ts", import.meta.url),
      { type: "module" });
    const wc = new WorkerClient(worker);
    workerRef.current = wc;
    void (async () => {
      try {
        const cur = currentApp();                     // registry entry or null
        const boot = await withTimeout(wc.boot(cur?.id), 20_000, "Opening the app");
        setPersistent(boot.persistent);

        // Device-global model access (B1): migrate any legacy per-app key up
        // to localStorage once, then push it to the worker. Shared by every
        // app — no re-entry on switch.
        if (!getApiKey()) {
          const legacy = await wc.getSetting<string>("byo_api_key");
          if (legacy) {
            setApiKey(legacy);
            await wc.deleteSetting("byo_api_key");
          }
        } else {
          await wc.deleteSetting("byo_api_key");
        }
        if (!getBackendUrl()) {
          const legacyB = await wc.getSetting<string>("backend_url");
          const legacyClay = await wc.getSetting<string>("clay_backend_url");
          if (legacyB || legacyClay) setBackendUrl(legacyB ?? legacyClay!);
        }
        await wc.deleteSetting("backend_url");
        await wc.deleteSetting("clay_backend_url");
        const selectedProvider = getModelProvider();
        const access = getActiveModelAccess();
        setModelProviderState(selectedProvider);
        await wc.setModelAccess(await prepareWorkerModelAccess(
          access, selectedProvider === "clay" ? getSessionToken(access.backendUrl) : null,
        ));
        setHasKey(hasModelAccess());

        // Existing single-app user with data but no registry: adopt it (G4).
        if (boot.seeded) ensureLegacyAdopted(true, boot.shellId);

        if (!boot.seeded) {
          if (cur) {
            // a freshly created additional app pending its first seed
            await withTimeout(wc.seed(cur.shellId as StarterShellId), 20_000, "Setting up the app");
          } else {
            setPhase("onboarding");         // first run ever — pick a template
            return;
          }
        }
        setApps(listApps());
        setCurrentId(currentApp()?.id ?? null);
        setLiveBridge(makeBridge(wc, "live", pushToast, recordFault, askConfirm,
          (table, id) => openRecordRef.current(table, id)));
        const [bootPanels, bootHistory, bootTables, bootSuggestions, bootProvenance,
          bootSemanticTrace, bootFieldProvenance] = await Promise.all([
          wc.panels(), wc.history(), wc.registryTables(), wc.suggestions(), wc.panelProvenance(),
          wc.semanticTrace(), wc.fieldProvenance(),
        ]);
        setPanels(bootPanels);
        setHistory(bootHistory);
        setRegistryTables(bootTables);
        setSuggestions(bootSuggestions);
        setPanelProvenance(bootProvenance);
        setSemanticTrace(bootSemanticTrace);
        setFieldProvenance(bootFieldProvenance);
        setPhase("main");
        void wc.recordPrivateMetric({ type: "app_ready",
          entry: boot.seeded ? "existing" : "new_starter" }).catch(() => undefined);
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
    return (): void => worker.terminate();
  }, [pushToast, recordFault]);

  const pickShell = async (id: StarterShellId): Promise<void> => {
    setBusy(true);
    const first = listApps().length === 0;
    createApp(shellName(id), id);
    if (first) {
      // the worker already holds this app's (empty, "default") files open
      await client().seed(id);
      setApps(listApps());
      setCurrentId(currentApp()?.id ?? null);
      setLiveBridge(makeBridge(client(), "live", pushToast, recordFault, askConfirm,
        (table, id) => openRecordRef.current(table, id)));
      await refreshPanels();
      setFeed([{ kind: "info", text: "Your app is ready. Describe any change to reshape it." }]);
      setBusy(false);
      setPhase("main");
      recordPrivateMetric({ type: "app_ready", entry: "new_starter" });
    } else {
      // an additional app: reboot so the worker opens its own files, then seed
      reloadApp();
    }
  };

  // Reload after terminating the worker so the next one can re-acquire the
  // OPFS pool without lock contention (a stuck cause on fast reloads).
  const reloadApp = (): void => {
    try { workerRef.current?.terminate(); } catch { /* ignore */ }
    setTimeout(() => window.location.reload(), 150);
  };
  const switchApp = (id: string): void => { setCurrentApp(id); reloadApp(); };
  const newApp = (): void => setPhase("onboarding");
  // B5 fork-and-explore: duplicate the current app (data + history + panels)
  // into a new one, then switch to it — experiment freely without risking the
  // original. Uses the validated .clay export/import path in the worker.
  const forkApp = async (): Promise<void> => {
    const cur = currentApp();
    const entry = addForkEntry(`${cur?.name ?? "My app"} (copy)`, cur?.shellId ?? "blank");
    try {
      await withTimeout(client().forkApp(entry.id), 20000, "Duplicating the app");
    } catch {
      removeApp(entry.id);
      pushToast("Couldn’t duplicate this app.", "danger");
      return;
    }
    reloadApp();   // boot the fork (its OPFS files are now populated)
  };
  const deleteApp = async (id: string): Promise<void> => {
    const entry = apps.find(a => a.id === id);
    if (!(await askConfirm(
      `Delete “${entry?.name ?? "this app"}” and all of its data? `
      + "This cannot be undone. (Export a .clay backup first if unsure.)"))) return;
    removeApp(id);
    try { await client().deleteApp(id); } catch { /* files may already be gone */ }
    reloadApp();
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
          await client().removeSamples();
          setFeed(f => [...f, { kind: "info", text: "Cleared the sample rows — only generated rows were removed; they're under each table's deleted rows if you need them back." }]);
        } else {
          const res = await client().fillSamples();
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
      handleOutcome(await client().intent(text));
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
    void client().acceptSuggestion(s.subject, s.kind);
    setSuggestions(list => list.filter(x => x.id !== s.id));
    void runIntent(s.intent, "observer_suggestion");
  };

  const dismissSuggestion = (s: Suggestion): void => {
    void client().dismissSuggestion(s.subject, s.kind);
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
      const outcome = await client().repairPanel(panelId, fault.message);
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
      setPanels(await client().revertPanel(panelId));
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
    const { bytes, filename } = await client().exportArchive();
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    try { localStorage.setItem("clay_last_backup", String(Date.now())); } catch { /* private mode */ }
    pushToast("Exported your whole app to one file", "success");
    recordPrivateMetric({ type: "backup_finished", action: "export", result: "success" });
  };

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

  const importArchive = async (file: File): Promise<void> => {
    if (!(await askConfirm(
      `Replace this app with the contents of "${file.name}"? `
      + `Your current data will be overwritten — export a backup first if unsure.`))) return;
    try {
      const result = await client().importArchive(await file.arrayBuffer());
      if (result.invalidPanels.length > 0) {
        window.alert(
          `Imported, but ${result.invalidPanels.length} panel(s) failed validation `
          + `and were flagged: ${result.invalidPanels.join(", ")} (G15).`);
      }
      recordPrivateMetric({ type: "backup_finished", action: "import", result: "success" });
      window.location.reload();
    } catch (e) {
      recordPrivateMetric({ type: "backup_finished", action: "import", result: "failed" });
      pushToast(e instanceof Error ? e.message : String(e), "danger");
    }
  };

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
  const openData = (table?: string, recordId?: string): void => {
    rememberSurfaceReturnFocus();
    dataStoreRef.current ??= new StoreRpcClient(
      portFromMessagePort(client().openStorePort("live")));
    setDataTable(table ?? null);
    setDataRecord(recordId ?? null);
    setShowData(true);
  };
  openRecordRef.current = (table, id): void => openData(table, id);
  const closeData = (): void => {
    setShowData(false);
    setDataRecord(null);
  };

  const closePreview = (): void => {
    setPreview(null);
    setShadowBridge(null);
  };

  const keep = async (): Promise<void> => {
    if (!preview) return;
    let version: number;
    try {
      ({ version } = await client().keep());
    } catch (error) {
      try { await client().discard(); } catch { /* preview may already be closed */ }
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
    if (!activationRecorded.current) {
      activationRecorded.current = true;
      firstKeepAt.current = Date.now();
      recordPrivateMetric({ type: "activation_completed",
        elapsed: durationBucket(Date.now() - appReadyAt.current) });
    }
    setFeed(f => [...f, { kind: "committed", summary: preview.summary, version, receipt }]);
    resetLens();
    closePreview();
    await refreshPanels();   // hot swap: keyed remount against the new blobs
    await refreshSuggestions();
    // A blank canvas earns its name from its first build — "My app"
    // reads unfinished; "Portfolio Dashboard" reads alive.
    const current = currentApp();
    if (current && current.name === "My app") {
      const derived = deriveAppName(preview.summary);
      if (derived) {
        renameApp(current.id, derived);
        setApps(listApps());
      }
    }
    // Rewind through the same confirmed path as History. If later versions
    // exist when this toast is clicked, they are named before truncation.
    pushToast(`Kept — your app is now v${version}`, "success", {
      label: "Rewind",
      run: () => void restoreToRef.current(version - 1),
    });
  };

  const discard = async (): Promise<void> => {
    if (!preview) return;
    await client().discard();
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

  const applyModelAccess = async (): Promise<void> => {
    const access = getActiveModelAccess();
    await client().setModelAccess(await prepareWorkerModelAccess(
      access, access.provider === "clay" ? getSessionToken(access.backendUrl) : null,
    ));
    setHasKey(hasModelAccess());
  };

  const selectModelProvider = async (provider: ModelProviderId): Promise<void> => {
    setModelProvider(provider);
    setModelProviderState(provider);
    await applyModelAccess();
    if (provider !== "clay") { setAccount(null); setMeter(null); }
    pushToast(`Model connection: ${provider === "codex" ? "Local Codex" : provider}`, "success");
  };

  const saveKey = async (key: string): Promise<void> => {
    setApiKey(key || null);
    setModelProvider("anthropic");
    setModelProviderState("anthropic");
    await applyModelAccess();
    pushToast("Anthropic key saved on this device — used by all your apps", "success");
  };

  const saveBackend = async (url: string): Promise<void> => {
    try {
      const normalized = url ? normalizeBackendUrl(url) : null;
      setBackendUrl(normalized);
      await applyModelAccess();
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
  useEffect(() => {
    if (phase !== "main") return;
    if (modelProvider !== "clay") { setMeter(null); setAccount(null); return; }
    const url = getBackendUrl();
    if (!url) { setMeter(null); setAccount(null); return; }
    void (async () => {
      try {
        const token = getSessionToken(url);
        const res = await fetch(url.replace(/\/$/, "") + "/me", {
          credentials: "include",
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

  // Magic-link sign-in. Dev backends return the link directly (no email
  // hop); production sends an email and we wait for the user to click.
  const signIn = async (email: string): Promise<void> => {
    const url = getActiveModelAccess().backendUrl?.replace(/\/$/, "");
    if (!url) { pushToast("Set the backend URL first", "danger"); return; }
    try {
      const res = await fetch(url + "/auth/magic-link", {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.status === 204) {
        pushToast("Check your email for the sign-in link, then come back here",
          "success", { label: "I clicked it", run: () => setAccountN(n => n + 1) });
        return;
      }
      const body = await res.json() as { link?: string; error?: string };
      if (!res.ok || !body.link) {
        pushToast(body.error ?? "Could not send the link", "danger");
        return;
      }
      const cb = await fetch(url + body.link, { credentials: "include" });
      const got = await cb.json() as { session?: string };
      if (got.session) {
        setSessionToken(got.session, url);
        const access = getActiveModelAccess();
        await client().setModelAccess(await prepareWorkerModelAccess(
          access, access.provider === "clay" ? got.session : null,
        ));
        setAccountN(n => n + 1);
        pushToast("Signed in — your reshapes now count against your plan", "success");
      }
    } catch (e) {
      pushToast("Sign-in failed: " + (e as Error).message, "danger");
    }
  };
  const signOut = async (): Promise<void> => {
    const backend = getActiveModelAccess().backendUrl;
    const session = getSessionToken(backend);
    if (backend && session) {
      try {
        await fetch(`${backend.replace(/\/$/, "")}/auth/logout`, {
          method: "POST",
          credentials: "include",
          headers: { authorization: `Bearer ${session}` },
        });
      } catch { /* local state still clears when the backend is unreachable */ }
    }
    setSessionToken(null);
    const access = getActiveModelAccess();
    await client().setModelAccess(await prepareWorkerModelAccess(access, null));
    setAccount(null); setMeter(null);
    pushToast("Signed out on this device", "default");
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
      await client().makeLatest(version);
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
      "Erase EVERYTHING and start over? All apps and their data are deleted. "
      + "This is the one action Clay cannot undo."))) return;
    try {
      if (!workerRef.current) throw new Error("worker unavailable");
      await withTimeout(workerRef.current.reset(), 5_000, "Erasing local data");
    } catch {
      try {
        await wipeOpfsWithoutWorker();
      } catch (error) {
        setBootError(`Could not erase local data: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    try { localStorage.removeItem("clay_apps"); localStorage.removeItem("clay_current_app"); }
    catch { /* ignore */ }
    window.location.reload();
  };

  const removeSamples = async (): Promise<void> => {
    await client().removeSamples();
    liveBridge?.notifyWrite("items");
    for (const p of panels)
      for (const q of p.declared_queries) liveBridge?.notifyWrite(q.from);
    pushToast("Sample rows removed", "success");
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
          {apps.filter(a => a.id !== currentId).map(a => (
            <button key={a.id} onClick={() => switchApp(a.id)}>Open “{a.name}”</button>
          ))}
          <button className="link danger" onClick={() => void resetApp()}>Start over…</button>
        </div>
        <p className="boot-error-hint">
          Tip: this often clears on a second try. If it keeps failing, open the
          console (F12) and send the [clay boot] error.
        </p>
      </div>
      {confirmDialog}
    </>);
  if (phase === "onboarding")
    return (
      <Onboarding
        onPick={id => void pickShell(id)}
        busy={busy}
        onCancel={listApps().length > 0 ? () => setPhase("main") : undefined}
      />
    );

  // Direct manipulation (B4): drag a panel by its grip to rearrange. Each
  // drop is a reversible commit — same timeline as language reshapes. Only
  // live (non-preview, non-scrub) panels are draggable.
  const canDrag = !scrub && !preview && busy === false;
  const applyLayout = async (placements: ReturnType<typeof reorder>): Promise<void> => {
    setDragId(null);
    const updated = await client().commitLayout(placements);
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
      [{ panel_id: panelId, region: p.placement.region, order: p.placement.order, ...dim }]);
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
    const updated = await client().renamePanel(panelId, title);
    setPanels(updated);
    setHistory(await client().history());
    await refreshProvenance();
  };
  const removePanelLocal = async (panelId: string): Promise<void> => {
    const title = panels.find(p => p.panel_id === panelId)?.title ?? panelId;
    if (!(await askConfirm(
      `Remove “${title}”? Your data is untouched — rewind the timeline to bring the panel back.`))) return;
    const updated = await client().removePanel(panelId);
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
      setPrivateMetricsSummary(await client().setPrivateMetricsEnabled(enabled));
      return true;
    } catch (error) {
      pushToast(error instanceof Error ? error.message : String(error), "danger");
      return false;
    }
  };

  const clearPrivateMetrics = async (): Promise<boolean> => {
    try {
      setPrivateMetricsSummary(await client().clearPrivateMetrics());
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
    const canArrange = canDrag && lensId === "all";
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
            provenance={!d.isPreview && !scrub ? provenanceById.get(d.panel.panel_id) : undefined}
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
            onViewAs={canDrag && !d.isPreview && d.panel.declared_queries.length > 0
              ? (view): void => viewAs(d.panel, view) : undefined}
            onEditData={!d.isPreview ? (table): void => openData(table) : undefined}
            onRename={canDrag && !d.isPreview
              ? (title): void => void renamePanelLocal(d.panel.panel_id, title) : undefined}
            onRemove={canDrag && !d.isPreview
              ? (): void => void removePanelLocal(d.panel.panel_id) : undefined}
            onAskAbout={!d.isPreview ? (): void => askAboutPanel(d.panel) : undefined}
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
        onSwitch={switchApp}
        onNew={newApp}
        onFork={() => void forkApp()}
        onRename={(id, name) => { renameApp(id, name); setApps(listApps()); }}
        onDelete={id => void deleteApp(id)}
        onOpenSearch={() => setShowCommandPalette(true)}
        onOpenAutomations={() => setShowAutomations(true)}
        unreadNotifications={notifications.filter(notification => !notification.read).length}
        onOpenData={() => openData()}
        onOpenShapeMap={() => void openShapeMap()}
        railOpen={railOpen}
        onToggleRail={toggleRail}
        version={head}
        persistent={persistent}
        themes={THEMES}
        themeId={themeId}
        onSelectTheme={selectTheme}
        lenses={lenses}
        lensId={lensId}
        lensReady={lensReady}
        onSelectLens={selectLens}
        onSaveLens={saveCurrentLens}
        onDeleteLens={removeSavedLens}
      />
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
            <div className="empty-canvas-spark">✦</div>
            <h2>What do you want to build?</h2>
            <p>Describe it in plain words, or <strong>upload a spreadsheet</strong> and
              Clay builds a dashboard around your data. Every change is reversible.</p>
            <label className="empty-upload file-label">
              ⬆ Upload a spreadsheet (CSV or JSON)
              <input type="file" accept=".csv,.tsv,.txt,.json" style={{ display: "none" }}
                disabled={busy}
                onChange={e => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ""; }} />
            </label>
            <div className="empty-canvas-or">or describe it</div>
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
      {showHistory ? (
        <LazySurfaceBoundary label="history" modal>
        <Suspense fallback={<SurfaceFallback label="history" modal />}>
        <HistoryView
          history={history}
          head={head}
          current={scrub?.version ?? head}
          onJump={v => { void scrubTo(v); closeHistory(); }}
          onRestore={v => void restoreTo(v)}
          onSetCheckpoint={(v, label) => void client().setCheckpoint(v, label).then(setHistory)}
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
              onNotifications={setNotifications}
              onClose={() => setShowAutomations(false)}
              onOpenRecord={(table, id) => openData(table, id)}
              onWrite={table => liveBridge?.notifyWrite(table)}
              onError={message => pushToast(message, "danger")}
              onInfo={message => pushToast(message, "info")}
              onConfirm={askConfirm}
            />
          </Suspense>
        </LazySurfaceBoundary>
      ) : null}
      {showCommandPalette && workerRef.current ? (
        <LazySurfaceBoundary label="search and act" modal>
          <Suspense fallback={<SurfaceFallback label="search and act" modal />}>
            <CommandPalette
              worker={workerRef.current}
              tables={registryTables}
              onClose={() => setShowCommandPalette(false)}
              onOpenRecord={(table, id) => openData(table, id)}
              onOpenData={table => openData(table)}
              onWrite={table => liveBridge?.notifyWrite(table)}
              onError={message => pushToast(message, "danger")}
              onInfo={message => pushToast(message, "info")}
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
          initialTable={dataTable}
          initialRecordId={dataRecord}
          returnFocusRef={surfaceReturnFocus}
          onImport={file => void importFile(file)}
          onWrite={table => liveBridge?.notifyWrite(table)}
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
      {railOpen ? <ConversationRail
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
        onImport={file => void importArchive(file)}
        onPurgeAttachments={async () => {
          const result = await client().purgeDeletedAttachments();
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
      {createPortal(<div className="toasts" aria-live="polite" aria-atomic="true">
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
      </div>, document.body)}
    </div>
  );
}
