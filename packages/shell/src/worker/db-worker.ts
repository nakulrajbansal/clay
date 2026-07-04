// The DB worker (doc 02 §1/§3): exclusively owns SQLite over OPFS and hosts
// the trusted kernel — ClayStore, Validator, and the MutationPipeline all
// run here. The main thread gets: a command protocol (below) plus
// serveStore RPC ports for the Bridge's AsyncStore (live and shadow).
// Records never leave this worker except over those ports to the Bridge.
import {
  ClayStore, MutationPipeline, openBrowserDriver, portFromMessagePort,
  serveStore, wipeBrowserStorage,
  type DbDriver, type LivePanel, type PreviewHandle,
} from "@clay/kernel";
import { MutationClient } from "@clay/mutation";
import { removeSampleRows, seedStarterShell, type StarterShellId } from "../shells/seed";

export type PreviewInfo = {
  summary: string;
  diff: { kind: string; detail: string }[];
  panels: LivePanel[];
  removePanels: string[];
  version: number;
  repaired: boolean;
};

export type IntentOutcome =
  | { status: "clarify"; question: string }
  | { status: "preview"; preview: PreviewInfo }
  | { status: "failed"; stage: string; reasons: string[] };

type Request = { id: number; op: string; payload?: Record<string, unknown> };

let store: ClayStore | null = null;
let persistent = false;
let pending: PreviewHandle | null = null;

function mustStore(): ClayStore {
  if (!store) throw new Error("worker not booted");
  return store;
}

function dropPending(): void {
  if (pending) { pending.discard(); pending = null; }
}

async function runPipelineText(text: string): Promise<IntentOutcome> {
  dropPending();   // one mutation in flight per app (doc 05 §6)
  const s = mustStore();
  const apiKey = s.getSetting<string>("byo_api_key");
  if (!apiKey) {
    return { status: "failed", stage: "plan", reasons: [
      "No model access configured. Add your Anthropic API key in Settings (BYO mode).",
    ] };
  }
  const client = new MutationClient({ mode: "byo", apiKey });
  const pipeline = new MutationPipeline(s, client);
  const result = await pipeline.run(text);
  if (result.status === "clarify")
    return { status: "clarify", question: result.question };
  if (result.status === "failed")
    return { status: "failed", stage: result.stage, reasons: result.reasons };
  pending = result.preview;
  return {
    status: "preview",
    preview: {
      summary: result.preview.plan.summary,
      diff: result.preview.plan.user_facing_diff,
      panels: result.preview.plan.panels.map(pa => ({
        panel_id: pa.panel_id, title: pa.title, placement: pa.placement,
        code: pa.code, declared_queries: pa.declared_queries,
        declared_writes: pa.declared_writes, version: result.preview.version,
      })),
      removePanels: result.preview.plan.remove_panels,
      version: result.preview.version,
      repaired: result.repaired,
    },
  };
}

async function handle(req: Request, ports: readonly MessagePort[]): Promise<unknown> {
  const p = req.payload ?? {};
  switch (req.op) {
    case "boot": {
      if (!store) {
        const opened = await openBrowserDriver();
        persistent = opened.persistent;
        store = ClayStore.fromDriver(opened.driver);
      }
      return {
        persistent,
        seeded: store.headVersion() > 0,
        shellId: store.getSetting<string>("shell_id") ?? null,
      };
    }
    case "seed":
      seedStarterShell(mustStore(), p.shellId as StarterShellId);
      return null;
    case "panels":
      return mustStore().livePanels();
    case "history":
      return mustStore().history();
    case "panelsAt":
      return mustStore().livePanels(Number(p.version));
    case "makeLatest": {
      // ADR-007: the one destructive-ish operation; the shell warns first.
      dropPending();
      mustStore().rollbackTo(Number(p.version), { truncate: true });
      return mustStore().livePanels();
    }
    case "registryTables":
      return [...mustStore().registrySnapshot().values()];
    case "storePort": {
      const port = ports[0];
      if (!port) throw new Error("storePort needs a transferred port");
      const target = p.target === "shadow" ? pending?.shadow : mustStore();
      if (!target) throw new Error("no shadow store open");
      port.start?.();
      serveStore(target, portFromMessagePort(port));
      return null;
    }
    case "intent":
      return runPipelineText(String(p.text ?? ""));
    case "repairPanel": {
      // doc 05 §7 Repair: one-round fix with the runtime error; the result
      // arrives as a NORMAL preview and never auto-commits.
      const panelId = String(p.panelId);
      const error = String(p.error ?? "unknown error").slice(0, 200);
      const text = (`The ${panelId} panel crashed at runtime with this error: ${error}. `
        + `Fix that panel. Keep its purpose and layout; change only what is `
        + `needed to stop the error.`).slice(0, 500);
      return runPipelineText(text);
    }
    case "revertPanel": {
      dropPending();
      mustStore().revertPanel(String(p.panelId));
      return mustStore().livePanels();
    }
    case "keep": {
      if (!pending) throw new Error("no preview open");
      const version = pending.keep();
      pending = null;
      return { version };
    }
    case "discard":
      dropPending();
      return null;
    case "removeSamples":
      removeSampleRows(mustStore());
      return null;
    case "restoreRow":
      mustStore().restoreRow(String(p.table), String(p.id));
      return null;
    case "restorableRows":
      return mustStore().restorableRows(String(p.table));
    case "reset": {
      // P4: deleting the local databases removes all local data.
      dropPending();
      store?.close();
      store = null;
      await wipeBrowserStorage();
      return null;
    }
    case "exportArchive": {
      const s = mustStore();
      const bytes = await s.exportArchive(s.getSetting<string>("shell_id") ?? "clay");
      return {
        bytes: bytes.buffer,
        filename: `clay-${new Date().toISOString().slice(0, 10)}.clay`,
      };
    }
    case "importArchive": {
      dropPending();
      const bytes = new Uint8Array(p.bytes as ArrayBuffer);
      // staging + integrity run BEFORE the live app is touched (doc 04 §7);
      // openFresh only fires once the archive has passed.
      const openFresh = persistent
        ? async (): Promise<DbDriver> => {
            store?.close();
            store = null;
            await wipeBrowserStorage();
            const opened = await openBrowserDriver();
            persistent = opened.persistent;
            return opened.driver;
          }
        : undefined;
      const result = await ClayStore.importArchive(bytes, openFresh);
      if (!openFresh) { store?.close(); }
      store = result.store;
      return { manifest: result.manifest, invalidPanels: result.invalidPanels };
    }
    case "getSetting":
      return mustStore().getSetting(String(p.key)) ?? null;
    case "setSetting":
      mustStore().setSetting(String(p.key), p.value);
      return null;
    default:
      throw new Error(`unknown op '${req.op}'`);
  }
}

self.onmessage = (ev: MessageEvent): void => {
  const req = ev.data as Request;
  void (async () => {
    try {
      const result = await handle(req, ev.ports);
      (self as unknown as Worker).postMessage({ id: req.id, ok: true, result });
    } catch (e) {
      (self as unknown as Worker).postMessage({
        id: req.id, ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  })();
};
