// The shell chrome (doc 02 §1): onboarding -> main screen with panel
// regions + conversation rail. Live panels bind to the live store's Bridge;
// during S5 the proposed panels render in place with a dashed frame,
// bound to a SECOND Bridge over the shadow store (preview-before-commit).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bridge, StoreRpcClient, portFromMessagePort, type LivePanel,
} from "@clay/kernel";
import { WorkerClient } from "./worker-client";
import type { IntentOutcome, PreviewInfo } from "../worker/db-worker";
import type { StarterShellId } from "../shells/seed";
import { ConversationRail, type FeedItem } from "./ConversationRail";
import { Onboarding } from "./Onboarding";
import { PanelFrame } from "./PanelFrame";

type Phase = "loading" | "onboarding" | "main";
type Toast = { id: number; msg: string; kind: string };

function makeBridge(client: WorkerClient, target: "live" | "shadow",
  onToast: (msg: string, kind: string) => void): Bridge {
  const port = client.openStorePort(target);
  const store = new StoreRpcClient(portFromMessagePort(port));
  return new Bridge(store, {
    onToast: (_panel, msg, kind) => onToast(msg, kind),
    onConfirm: async (_panel, msg) => window.confirm(msg),
  });
}

export function App(): React.JSX.Element {
  const workerRef = useRef<WorkerClient | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [persistent, setPersistent] = useState(true);
  const [panels, setPanels] = useState<LivePanel[]>([]);
  const [liveBridge, setLiveBridge] = useState<Bridge | null>(null);
  const [shadowBridge, setShadowBridge] = useState<Bridge | null>(null);
  const [preview, setPreview] = useState<PreviewInfo | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [hasKey, setHasKey] = useState(false);
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

  const refreshPanels = useCallback(async (): Promise<void> => {
    setPanels(await client().panels());
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
      setHasKey((await wc.getSetting<string>("byo_api_key")) !== null);
      if (!boot.seeded) { setPhase("onboarding"); return; }
      setLiveBridge(makeBridge(wc, "live", pushToast));
      setPanels(await wc.panels());
      setPhase("main");
    })();
    return (): void => worker.terminate();
  }, [pushToast]);

  const pickShell = async (id: StarterShellId): Promise<void> => {
    setBusy(true);
    await client().seed(id);
    setLiveBridge(makeBridge(client(), "live", pushToast));
    await refreshPanels();
    setFeed([{ kind: "info", text: "Your app is ready. Describe any change to reshape it." }]);
    setBusy(false);
    setPhase("main");
  };

  const runIntent = async (text: string): Promise<void> => {
    setFeed(f => [...f, { kind: "intent", text }]);
    setBusy(true);
    try {
      const outcome: IntentOutcome = await client().intent(text);
      if (outcome.status === "clarify") {
        setFeed(f => [...f, { kind: "clarify", question: outcome.question }]);
      } else if (outcome.status === "failed") {
        setFeed(f => [...f, { kind: "failure", reasons: outcome.reasons }]);
      } else {
        setPreview(outcome.preview);
        setShadowBridge(makeBridge(client(), "shadow", pushToast));
      }
    } catch (e) {
      setFeed(f => [...f, { kind: "failure", reasons: [String(e)] }]);
    } finally {
      setBusy(false);
    }
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

  const removeSamples = async (): Promise<void> => {
    await client().removeSamples();
    liveBridge?.notifyWrite("items");
    for (const p of panels)
      for (const q of p.declared_queries) liveBridge?.notifyWrite(q.from);
    pushToast("Sample rows removed", "success");
  };

  // S5: proposed panels render in place (dashed), replacing same-id live
  // panels; panels slated for removal are ghosted.
  const display = useMemo(() => {
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
  }, [panels, preview]);

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
        <div className="region-top">{region("top")}</div>
        <div className="region-main">{region("main")}</div>
        <div className="region-side">{region("side")}</div>
      </main>
      <ConversationRail
        feed={feed}
        preview={preview}
        busy={busy}
        hasKey={hasKey}
        onIntent={t => void runIntent(t)}
        onKeep={() => void keep()}
        onDiscard={() => void discard()}
        onSaveKey={k => void saveKey(k)}
        onRemoveSamples={() => void removeSamples()}
      />
      <div className="toasts">
        {toasts.map(t => (
          <div key={t.id} className={`toast toast-${t.kind}`}>{t.msg}</div>
        ))}
      </div>
    </div>
  );
}
