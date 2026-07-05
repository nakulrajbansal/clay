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
import { Onboarding } from "./Onboarding";
import { PanelFrame } from "./PanelFrame";
import { TimeSlider } from "./TimeSlider";

type Phase = "loading" | "onboarding" | "main";
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

  // boot
  useEffect(() => {
    const worker = new Worker(new URL("../worker/db-worker.ts", import.meta.url),
      { type: "module" });
    const wc = new WorkerClient(worker);
    workerRef.current = wc;
    void (async () => {
      const boot = await wc.boot();
      setPersistent(boot.persistent);
      setHasKey((await wc.getSetting<string>("byo_api_key")) !== null
        || (await wc.getSetting<string>("backend_url")) !== null);
      if (!boot.seeded) { setPhase("onboarding"); return; }
      setLiveBridge(makeBridge(wc, "live", pushToast, recordFault));
      setPanels(await wc.panels());
      setHistory(await wc.history());
      setSuggestions(await wc.suggestions());
      setPhase("main");
    })();
    return (): void => worker.terminate();
  }, [pushToast, recordFault]);

  const pickShell = async (id: StarterShellId): Promise<void> => {
    setBusy(true);
    await client().seed(id);
    setLiveBridge(makeBridge(client(), "live", pushToast, recordFault));
    await refreshPanels();
    setFeed([{ kind: "info", text: "Your app is ready. Describe any change to reshape it." }]);
    setBusy(false);
    setPhase("main");
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
    await client().setSetting("byo_api_key", key);
    setHasKey(true);
    pushToast("API key saved locally", "success");
  };

  const saveBackend = async (url: string): Promise<void> => {
    await client().setSetting("backend_url", url || null);
    setHasKey(url !== "" || (await client().getSetting<string>("byo_api_key")) !== null);
    pushToast(url ? "Hosted backend set" : "Hosted backend cleared", "success");
  };

  const head = history.length > 0 ? history[history.length - 1]!.version : 0;

  const scrubTo = async (version: number): Promise<void> => {
    if (version >= head) { setScrub(null); return; }
    const panelsAt = await client().panelsAt(version);
    setScrub({ version, panels: panelsAt });
  };

  const makeLatest = async (): Promise<void> => {
    if (!scrub) return;
    const dropped = history.filter(h => h.version > scrub.version).length;
    if (!window.confirm(
      `Rewind your app to v${scrub.version}? The ${dropped} newer change${dropped === 1 ? "" : "s"} `
      + `will be removed from history. Data rows are always kept.`)) return;
    const fresh = await client().makeLatest(scrub.version);
    setScrub(null);
    setPanels(fresh);
    setHistory(await client().history());
    setFeed(f => [...f, { kind: "info", text: `Rewound — v${scrub.version} is the latest again.` }]);
  };

  const resetApp = async (): Promise<void> => {
    if (!window.confirm(
      "Erase this app and start over? All data in it is deleted. "
      + "This is the one action Clay cannot undo.")) return;
    await client().reset();
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
  if (phase === "onboarding") return <Onboarding onPick={id => void pickShell(id)} busy={busy} />;

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
          />
        );
      });

  return (
    <div className="app">
      {!persistent ? (
        <div className="banner">
          This browser can’t persist data (no OPFS) — your work will vanish
          when the tab closes. Export early, export often.
        </div>
      ) : null}
      <main className="regions">
        <TimeSlider
          history={history}
          current={scrub?.version ?? head}
          scrubbed={scrub !== null}
          disabled={busy || preview !== null}
          onScrub={v => void scrubTo(v)}
          onMakeLatest={() => void makeLatest()}
        />
        <div className="region-top">{region("top")}</div>
        <div className="region-main">{region("main")}</div>
        <div className="region-side">{region("side")}</div>
      </main>
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
      <div className="toasts">
        {toasts.map(t => (
          <div key={t.id} className={`toast toast-${t.kind}`}>{t.msg}</div>
        ))}
      </div>
    </div>
  );
}
