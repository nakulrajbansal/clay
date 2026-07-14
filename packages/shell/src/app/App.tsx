// The shell chrome (doc 02 §1): onboarding -> main screen with panel
// regions + conversation rail. Live panels bind to the live store's Bridge;
// during S5 the proposed panels render in place with a dashed frame,
// bound to a SECOND Bridge over the shadow store (preview-before-commit).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bridge, StoreRpcClient, portFromMessagePort,
  type HistoryEntry, type LivePanel, type Suggestion,
} from "@clay/kernel";
import { WorkerClient } from "./worker-client";
import type { IntentOutcome, PreviewInfo } from "../worker/db-worker";
import type { StarterShellId } from "../shells/seed";
import { ConversationRail, type FeedItem } from "./ConversationRail";
import { DataView } from "./DataView";
import { HistoryView } from "./HistoryView";
import { Onboarding } from "./Onboarding";
import { PanelFrame } from "./PanelFrame";
import { TimeSlider } from "./TimeSlider";
import { AppSwitcher } from "./AppSwitcher";
import {
  addForkEntry, createApp, currentApp, ensureLegacyAdopted, listApps, removeApp,
  renameApp, setCurrentApp, shellName, type AppEntry,
} from "./apps";
import {
  getApiKey, getBackendUrl, hasModelAccess, setApiKey, setBackendUrl,
} from "./settings";
import { reorder } from "./layout";

type Phase = "loading" | "onboarding" | "main" | "error";

/** Reject if a promise doesn't settle in time — turns a silent OPFS/worker
 * stall into a visible, recoverable error instead of an eternal spinner. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms)),
  ]);
}
type Toast = { id: number; msg: string; kind: string };

type PanelFault = { code: string; message: string };

function makeBridge(client: WorkerClient, target: "live" | "shadow",
  onToast: (msg: string, kind: string) => void,
  onFault: (panelId: string, fault: PanelFault) => void): Bridge {
  const port = client.openStorePort(target);
  const store = new StoreRpcClient(portFromMessagePort(port));
  return new Bridge(store, {
    onToast: (_panel, msg, kind) => onToast(msg, kind),
    onConfirm: async (_panel, msg) => window.confirm(msg),
    onPanelError: (panelId, code, message) => onFault(panelId, { code, message }),
    onBoundary: (panelId, reason) =>
      onFault(panelId, { code: "E_STRIKES", message: reason }),
    // live bridge only: feed the Observer's repeated-filter heuristic
    onEvent: target === "live"
      ? (_panel, name, payload) => { void client.recordFilter(name, payload); }
      : undefined,
  });
}

export function App(): React.JSX.Element {
  const workerRef = useRef<WorkerClient | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [intentSeed, setIntentSeed] = useState<{ text: string; n: number }>({ text: "", n: 0 });
  const seedIntent = (t: string): void => setIntentSeed(s => ({ text: t, n: s.n + 1 }));
  const [persistent, setPersistent] = useState(true);
  const [panels, setPanels] = useState<LivePanel[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [scrub, setScrub] = useState<{ version: number; panels: LivePanel[] } | null>(null);
  const [liveBridge, setLiveBridge] = useState<Bridge | null>(null);
  const [shadowBridge, setShadowBridge] = useState<Bridge | null>(null);
  const [preview, setPreview] = useState<PreviewInfo | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [faults, setFaults] = useState<Record<string, PanelFault>>({});
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showData, setShowData] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const dataStoreRef = useRef<StoreRpcClient | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const pushToast = useCallback((msg: string, kind: string): void => {
    const id = ++toastId.current;
    setToasts(t => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3500);
  }, []);

  const client = (): WorkerClient => {
    if (!workerRef.current) throw new Error("worker not ready");
    return workerRef.current;
  };

  const recordFault = useCallback((panelId: string, fault: PanelFault): void => {
    setFaults(f => (f[panelId] ? f : { ...f, [panelId]: fault }));
  }, []);

  const refreshPanels = useCallback(async (): Promise<void> => {
    setPanels(await client().panels());
    setHistory(await client().history());
    setFaults({});
  }, []);

  const refreshSuggestions = useCallback(async (): Promise<void> => {
    try { setSuggestions(await client().suggestions()); }
    catch { /* pre-boot */ }
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
          if (legacy) setApiKey(legacy);
        }
        if (!getBackendUrl()) {
          const legacyB = await wc.getSetting<string>("backend_url");
          if (legacyB) setBackendUrl(legacyB);
        }
        await wc.setModelAccess(getApiKey(), getBackendUrl());
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
        setLiveBridge(makeBridge(wc, "live", pushToast, recordFault));
        setPanels(await wc.panels());
        setHistory(await wc.history());
        setSuggestions(await wc.suggestions());
        setPhase("main");
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
      setLiveBridge(makeBridge(client(), "live", pushToast, recordFault));
      await refreshPanels();
      setFeed([{ kind: "info", text: "Your app is ready. Describe any change to reshape it." }]);
      setBusy(false);
      setPhase("main");
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
    if (!window.confirm(
      `Delete “${entry?.name ?? "this app"}” and all of its data? `
      + "This cannot be undone. (Export a .clay backup first if unsure.)")) return;
    removeApp(id);
    try { await client().deleteApp(id); } catch { /* files may already be gone */ }
    reloadApp();
  };

  const handleOutcome = (outcome: IntentOutcome): void => {
    if (outcome.status === "clarify") {
      setFeed(f => [...f, { kind: "clarify", question: outcome.question }]);
    } else if (outcome.status === "failed") {
      setFeed(f => [...f, { kind: "failure", reasons: outcome.reasons }]);
    } else {
      setPreview(outcome.preview);
      setShadowBridge(makeBridge(client(), "shadow", pushToast, recordFault));
    }
  };

  const runIntent = async (text: string): Promise<void> => {
    setFeed(f => [...f, { kind: "intent", text }]);
    setBusy(true);
    try {
      handleOutcome(await client().intent(text));
    } catch (e) {
      setFeed(f => [...f, { kind: "failure", reasons: [String(e)] }]);
    } finally {
      setBusy(false);
    }
  };

  const acceptSuggestion = (s: Suggestion): void => {
    void client().acceptSuggestion(s.subject, s.kind);
    setSuggestions(list => list.filter(x => x.id !== s.id));
    void runIntent(s.intent);
  };

  const dismissSuggestion = (s: Suggestion): void => {
    void client().dismissSuggestion(s.subject, s.kind);
    setSuggestions(list => list.filter(x => x.id !== s.id));
  };

  // doc 05 §7 boundary actions
  const repairPanel = async (panelId: string): Promise<void> => {
    const fault = faults[panelId];
    if (!fault) return;
    setFeed(f => [...f, { kind: "info", text: `Repairing ${panelId} (${fault.message.slice(0, 80)})…` }]);
    setBusy(true);
    try {
      handleOutcome(await client().repairPanel(panelId, fault.message));
    } catch (e) {
      setFeed(f => [...f, { kind: "failure", reasons: [String(e)] }]);
    } finally {
      setBusy(false);
    }
  };

  const revertPanel = async (panelId: string): Promise<void> => {
    try {
      setPanels(await client().revertPanel(panelId));
      setHistory(await client().history());
      setFaults(f => { const { [panelId]: _drop, ...rest } = f; return rest; });
      setFeed(f => [...f, { kind: "info", text: `Rolled back the ${panelId} panel.` }]);
    } catch (e) {
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
    pushToast("Exported your whole app to one file", "success");
  };

  const importArchive = async (file: File): Promise<void> => {
    if (!window.confirm(
      `Replace this app with the contents of "${file.name}"? `
      + `Your current data will be overwritten — export a backup first if unsure.`)) return;
    try {
      const result = await client().importArchive(await file.arrayBuffer());
      if (result.invalidPanels.length > 0) {
        window.alert(
          `Imported, but ${result.invalidPanels.length} panel(s) failed validation `
          + `and were flagged: ${result.invalidPanels.join(", ")} (G15).`);
      }
      window.location.reload();   // clean re-boot against the imported app
    } catch (e) {
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

  const openData = (): void => {
    dataStoreRef.current ??= new StoreRpcClient(
      portFromMessagePort(client().openStorePort("live")));
    setShowData(true);
  };

  const closePreview = (): void => {
    setPreview(null);
    setShadowBridge(null);
  };

  const keep = async (): Promise<void> => {
    if (!preview) return;
    const { version } = await client().keep();
    setFeed(f => [...f, { kind: "committed", summary: preview.summary, version }]);
    closePreview();
    await refreshPanels();   // hot swap: keyed remount against the new blobs
    await refreshSuggestions();
  };

  const discard = async (): Promise<void> => {
    if (!preview) return;
    await client().discard();
    setFeed(f => [...f, { kind: "discarded", summary: preview.summary }]);
    closePreview();
  };

  const saveKey = async (key: string): Promise<void> => {
    setApiKey(key || null);                                   // device-global
    await client().setModelAccess(getApiKey(), getBackendUrl());
    setHasKey(hasModelAccess());
    pushToast("API key saved on this device — used by all your apps", "success");
  };

  const saveBackend = async (url: string): Promise<void> => {
    setBackendUrl(url || null);                               // device-global
    await client().setModelAccess(getApiKey(), getBackendUrl());
    setHasKey(hasModelAccess());
    pushToast(url ? "Hosted backend set for all apps" : "Hosted backend cleared", "success");
  };

  const head = history.length > 0 ? history[history.length - 1]!.version : 0;

  const scrubTo = async (version: number): Promise<void> => {
    if (version >= head) { setScrub(null); return; }
    const panelsAt = await client().panelsAt(version);
    setScrub({ version, panels: panelsAt });
  };

  const restoreTo = async (version: number): Promise<void> => {
    if (version >= head) return;
    const dropped = history.filter(h => h.version > version).length;
    if (!window.confirm(
      `Rewind your app to v${version}? The ${dropped} newer change${dropped === 1 ? "" : "s"} `
      + `will be removed from history. Data rows are always kept.`)) return;
    const fresh = await client().makeLatest(version);
    setScrub(null);
    setPanels(fresh);
    setHistory(await client().history());
    setFeed(f => [...f, { kind: "info", text: `Rewound — v${version} is the latest again.` }]);
  };
  const makeLatest = async (): Promise<void> => {
    if (scrub) await restoreTo(scrub.version);
  };

  const resetApp = async (): Promise<void> => {
    if (!window.confirm(
      "Erase EVERYTHING and start over? All apps and their data are deleted. "
      + "This is the one action Clay cannot undo.")) return;
    await client().reset();
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

  if (phase === "loading") return <div className="boot">Opening your app…</div>;
  if (phase === "error")
    return (
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
    );
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
    pushToast("Rearranged — rewind any time in the timeline", "success");
  };
  // Resize (B4/ADR-017): toggle a panel between 1 and 2 columns — a
  // reversible commit, same timeline as everything else.
  const toggleWidth = async (panelId: string): Promise<void> => {
    const p = panels.find(x => x.panel_id === panelId);
    if (!p) return;
    const w = (p.placement.w ?? 1) === 2 ? 1 : 2;
    const updated = await client().commitLayout(
      [{ panel_id: panelId, region: p.placement.region, order: p.placement.order, w }]);
    setPanels(updated);
    setHistory(await client().history());
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

  const onRegionDrop = (regionName: "top" | "main" | "side", e: React.DragEvent): void => {
    if (!dragId) return;
    e.preventDefault();
    const frames = [...e.currentTarget.querySelectorAll(".panel-frame")];
    let index = frames.findIndex(f => {
      const r = f.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    if (index < 0) index = frames.length;
    const placements = reorder(panels, dragId, regionName, index);
    void applyLayout(placements);
  };

  const region = (name: "top" | "main" | "side"): React.JSX.Element[] =>
    display
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
        return (
          <PanelFrame
            key={`${d.panel.panel_id}@${d.panel.version}${d.isPreview ? ":preview" : ""}`}
            panel={d.panel}
            bridge={bridge}
            preview={d.isPreview}
            fault={faults[d.panel.panel_id]}
            onRepair={d.isPreview ? undefined : (): void => void repairPanel(d.panel.panel_id)}
            onRevert={d.isPreview ? undefined : (): void => void revertPanel(d.panel.panel_id)}
            onDismiss={(): void => dismissFault(d.panel.panel_id)}
            onDragStart={canDrag && !d.isPreview ? setDragId : undefined}
            onDragEnd={(): void => setDragId(null)}
            draggingSrc={dragId === d.panel.panel_id}
            wide={(d.panel.placement.w ?? 1) === 2}
            onResize={canDrag && !d.isPreview && d.panel.placement.region === "main"
              ? (): void => void toggleWidth(d.panel.panel_id) : undefined}
            onViewAs={canDrag && !d.isPreview && d.panel.declared_queries.length > 0
              ? (view): void => viewAs(d.panel, view) : undefined}
          />
        );
      });

  const dragOver = (e: React.DragEvent): void => { if (dragId) e.preventDefault(); };

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
      />
      {!persistent ? (
        <div className="banner">
          This browser can’t persist data (no OPFS) — your work will vanish
          when the tab closes. Export early, export often.
        </div>
      ) : null}
      <div className="app-body">
      <main className="regions">
        <TimeSlider
          history={history}
          current={scrub?.version ?? head}
          scrubbed={scrub !== null}
          disabled={busy || preview !== null}
          onScrub={v => void scrubTo(v)}
          onMakeLatest={() => void makeLatest()}
          onOpenHistory={() => setShowHistory(true)}
        />
        {display.length === 0 && !preview && !scrub ? (
          <div className="empty-canvas">
            <div className="empty-canvas-spark">✦</div>
            <h2>What do you want to build?</h2>
            <p>Describe it in plain words — a tracker, a CRM, a planner, anything.
              Clay builds it, and every change is reversible.</p>
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
            <div className="region-top" onDragOver={dragOver} onDrop={e => onRegionDrop("top", e)}>{region("top")}</div>
            <div className="region-main" onDragOver={dragOver} onDrop={e => onRegionDrop("main", e)}>{region("main")}</div>
            <div className="region-side" onDragOver={dragOver} onDrop={e => onRegionDrop("side", e)}>{region("side")}</div>
          </>
        )}
      </main>
      {showHistory ? (
        <HistoryView
          history={history}
          head={head}
          current={scrub?.version ?? head}
          onJump={v => { void scrubTo(v); setShowHistory(false); }}
          onRestore={v => void restoreTo(v)}
          onSetCheckpoint={(v, label) => void client().setCheckpoint(v, label).then(setHistory)}
          onClose={() => setShowHistory(false)}
        />
      ) : null}
      {showData && dataStoreRef.current && workerRef.current ? (
        <DataView
          worker={workerRef.current}
          store={dataStoreRef.current}
          onWrite={table => liveBridge?.notifyWrite(table)}
          onClose={() => setShowData(false)}
          onError={msg => pushToast(msg, "danger")}
        />
      ) : null}
      <ConversationRail
        feed={feed}
        preview={preview}
        busy={busy || scrub !== null}
        onOpenData={openData}
        hasKey={hasKey}
        suggestions={suggestions}
        onAcceptSuggestion={acceptSuggestion}
        onDismissSuggestion={dismissSuggestion}
        loadStatus={() => client().status()}
        seed={intentSeed}
        onIntent={t => void runIntent(t)}
        onKeep={() => void keep()}
        onDiscard={() => void discard()}
        onSaveKey={k => void saveKey(k)}
        onSaveBackend={u => void saveBackend(u)}
        onRemoveSamples={() => void removeSamples()}
        onReset={() => void resetApp()}
        onExport={() => void exportArchive()}
        onImport={file => void importArchive(file)}
        onCopyDiagnostics={() => void copyDiagnostics()}
      />
      </div>
      <div className="toasts">
        {toasts.map(t => (
          <div key={t.id} className={`toast toast-${t.kind}`}>{t.msg}</div>
        ))}
      </div>
    </div>
  );
}
