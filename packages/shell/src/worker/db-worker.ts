// The DB worker (doc 02 §1/§3): exclusively owns SQLite over OPFS and hosts
// the trusted kernel — ClayStore, Validator, and the MutationPipeline all
// run here. The main thread gets: a command protocol (below) plus
// serveStore RPC ports for the Bridge's AsyncStore (live and shadow).
// Records never leave this worker except over those ports to the Bridge.
import {
  ClayStore, MutationPipeline, deleteAppStorage, deriveInverse, openBrowserDriver,
  portFromMessagePort, serveStore, wipeBrowserStorage,
  type DbDriver, type DebugEvent, type LivePanel, type MigrationPlanT, type PreviewHandle,
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

type ImportColumn = { name: string; type: string; values?: string[] };

/** A basic, always-valid table panel so imported data is visible immediately
 * (before any model reshape). Columns are formatted by inferred type. */
function importTablePanelCode(table: string, columns: ImportColumn[]): string {
  const cols = columns.map(c => {
    const fmt = c.type === "number" ? ', format: "number"'
      : c.type === "date" ? ', format: "date"' : "";
    return `{ field: ${JSON.stringify(c.name)}, label: ${JSON.stringify(c.name)}${fmt} }`;
  }).join(", ");
  return `export default function (clay) {
  clay.db.watch({ from: ${JSON.stringify(table)}, limit: 500 }, (rows) => {
    clay.ui.render(rows.length === 0
      ? h(EmptyState, { label: "No rows yet" })
      : h(Table, { sortable: true, rows, columns: [${cols}] }));
  });
}`;
}

let store: ClayStore | null = null;
let persistent = false;
let persistRequested = false;
let pending: PreviewHandle | null = null;
let currentAppId: string | undefined;   // which app's OPFS files are open (G4)
// Device-global model access (B1): set by the main thread from localStorage,
// shared across every app, never persisted in an app DB.
let modelAccess: { apiKey?: string; backendUrl?: string } = {};

// A ring of recent pipeline traces the user can review/copy (the user
// asked for logs of inputs -> processing -> outputs). Also mirrored to the
// worker console (visible in DevTools).
type TraceEntry = { at: string; intent: string; events: DebugEvent[] };
const traceLog: TraceEntry[] = [];
const TRACE_CAP = 25;

function recordTrace(entry: TraceEntry): void {
  traceLog.unshift(entry);
  if (traceLog.length > TRACE_CAP) traceLog.length = TRACE_CAP;
}

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
  const backendUrl = modelAccess.backendUrl;
  const apiKey = modelAccess.apiKey;
  // Hosted first (ADR-011): if a backend is configured, use it and no
  // browser key is needed. Otherwise fall back to BYO.
  const client = backendUrl
    ? new MutationClient({ mode: "hosted", endpoint: backendUrl.replace(/\/$/, "") })
    : apiKey
      ? new MutationClient({ mode: "byo", apiKey })
      : null;
  if (!client) {
    return { status: "failed", stage: "plan", reasons: [
      "No model access configured. In Settings, either add a Clay backend URL "
      + "(hosted) or your own Anthropic API key (BYO).",
    ] };
  }
  const events: DebugEvent[] = [];
  const pipeline = new MutationPipeline(s, client, {
    onDebug: (ev) => {
      events.push(ev);
      // Console (DevTools): raw model output truncated, everything else full.
      const printable = ev.stage === "plan" && ev.raw
        ? { ...ev, raw: ev.raw.slice(0, 2000) } : ev;
      console.log(`[clay pipeline] ${ev.stage}`, printable);
    },
  });
  const result = await pipeline.run(text);
  recordTrace({ at: new Date().toISOString(), intent: text, events });
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
      const appId = p.appId === undefined ? undefined : String(p.appId);
      if (!store) {
        const opened = await openBrowserDriver(appId);
        persistent = opened.persistent;
        currentAppId = appId;
        store = ClayStore.fromDriver(opened.driver);
      }
      return {
        persistent,
        seeded: store.headVersion() > 0,
        shellId: store.getSetting<string>("shell_id") ?? null,
      };
    }
    case "setModelAccess": {
      modelAccess = {
        apiKey: p.apiKey ? String(p.apiKey) : undefined,
        backendUrl: p.backendUrl ? String(p.backendUrl) : undefined,
      };
      return null;
    }
    case "forkApp": {
      // B5 fork-and-explore: copy the CURRENT app (schema + data + history +
      // panels) into a brand-new app's OPFS files, via the same validated
      // .clay export/import path. The current app is left untouched — the
      // client boots the fork after a reload.
      const newId = String(p.newAppId);
      const s = mustStore();
      const bytes = await s.exportArchive(s.getSetting<string>("shell_id") ?? "clay");
      const openNew = async (): Promise<DbDriver> => (await openBrowserDriver(newId)).driver;
      const result = await ClayStore.importArchive(bytes, openNew);
      result.store.close();          // populated on disk; not the live store
      return null;
    }
    case "deleteApp": {
      // G4: delete one app's files. If it's the open one, close first.
      const appId = String(p.appId);
      if (appId === currentAppId || (appId === "default" && currentAppId === undefined)) {
        dropPending();
        store?.close();
        store = null;
        currentAppId = undefined;
      }
      await deleteAppStorage(appId);
      return null;
    }
    case "seed":
      seedStarterShell(mustStore(), p.shellId as StarterShellId);
      return null;
    case "importTable": {
      // Bring-your-own-data: create the table + a starter view and insert the
      // parsed rows as ONE reversible commit (data outlives interface). The
      // model builds the richer dashboard afterwards.
      const s = mustStore();
      const columns = p.columns as ImportColumn[];
      const rows = p.rows as Record<string, unknown>[];
      const reg = s.registrySnapshot();
      let table = String(p.table);
      let n = 2;
      while (reg.has(table)) table = `${String(p.table)}_${n++}`;   // avoid collision
      const ops: MigrationPlanT["operations"] = [{
        op: "create_table", table,
        columns: columns.map(c => ({
          name: c.name, type: c.type as "text", required: false,
          ...(c.values ? { values: c.values } : {}),
        })),
      }];
      const panelId = `${table}_view`.slice(0, 40).replace(/^[^a-z]/, "t");
      s.commit({
        intent: `Import data (${table})`,
        summary: `Imported ${rows.length} row${rows.length === 1 ? "" : "s"} into ${table}.`,
        migration: { operations: ops, inverse: deriveInverse(ops, reg) },
        panels: [{
          panel_id: panelId, title: table, placement: { region: "main", order: 0, w: 4 },
          code: importTablePanelCode(table, columns),
          declared_queries: [{ from: table, limit: 500 }], declared_writes: [],
        }],
      });
      let imported = 0;
      for (const row of rows) { try { s.insert(table, row); imported++; } catch { /* skip bad row */ } }
      return { table, imported, columns: columns.length };
    }
    case "panels":
      return mustStore().livePanels();
    case "commitLayout":
      mustStore().commitLayout(
        p.placements as { panel_id: string; region: "top" | "main" | "side"; order: number; w?: number }[]);
      return mustStore().livePanels();
    case "history":
      return mustStore().history();
    case "setCheckpoint":
      mustStore().setCheckpoint(Number(p.version), String(p.label ?? ""));
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
      // doc 04 §8: request durable storage at the first kept mutation.
      if (!persistRequested && persistent
          && typeof navigator !== "undefined" && navigator.storage?.persist) {
        persistRequested = true;
        try { await navigator.storage.persist(); } catch { /* best effort */ }
      }
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
    case "suggestions":
      return mustStore().suggestions();
    case "recordFilter":
      mustStore().recordUsage({ kind: "filter",
        subject: String(p.name), detail: p.payload as Record<string, unknown> });
      return null;
    case "dismissSuggestion":
      mustStore().dismissSuggestion(String(p.subject), String(p.kind));
      return null;
    case "acceptSuggestion":
      mustStore().acceptSuggestion(String(p.subject), String(p.kind));
      return null;
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
    case "status": {
      // navigator.storage.persist() requested at first commit (doc 04 §8),
      // status + usage estimate surfaced here.
      let persisted = persistent;
      let usageBytes: number | null = null;
      let quotaBytes: number | null = null;
      try {
        if (persistent && typeof navigator !== "undefined" && navigator.storage) {
          persisted = await navigator.storage.persisted();
          const est = await navigator.storage.estimate();
          usageBytes = est.usage ?? null;
          quotaBytes = est.quota ?? null;
        }
      } catch { /* estimate unavailable */ }
      return {
        persistent, persisted, usageBytes, quotaBytes,
        versions: mustStore().headVersion(),
        stats: mustStore().attemptStats(),
      };
    }
    case "requestPersist": {
      if (typeof navigator !== "undefined" && navigator.storage?.persist)
        return { persisted: await navigator.storage.persist() };
      return { persisted: false };
    }
    case "debugLog":
      return traceLog;
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
