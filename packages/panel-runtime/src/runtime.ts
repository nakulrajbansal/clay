// PanelRuntime (doc 06 §2): the fixed bootstrap inside each panel iframe.
// Receives the boot message once, constructs the `clay` proxy (each async
// method = message send + pending-promise map), evaluates the panel module,
// and invokes default(clay). clay.compute runs in-iframe and synchronously
// (G20) via the shared ExpressionEngine.
//
// Module evaluation note: in the real iframe host the module is imported
// from a Blob URL after the srcdoc bootstrap defines h/components as
// globals. This runtime uses a Function wrapper so the identical code path
// runs under jsdom tests and inside the iframe; the Blob-URL import host
// arrives with the shell (W2).
import { compileExpr, evalExpr, parseExpr, typecheckExpr } from "@clay/kernel/expr";
import type { ExprScope, ExprValue } from "@clay/kernel/expr";
import { PANEL_GLOBALS, h, render, type SchemaTable, type VChild } from "./vnode";

export type PortLike = {
  send(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): void;
};

export type BootMessage = {
  v: 1; kind: "boot";
  code: string; panelId: string; apiVersion: 1;
  meta: { schema: unknown; appVersion: number; placement: unknown };
  tokens: Record<string, string>;
};

type Reply = { v: 1; seq: number; ok: boolean; result?: unknown;
  error?: { code: string; message: string } };
type Push =
  | { v: 1; kind: "watch"; watchId: string; rows: Record<string, unknown>[] }
  | { v: 1; kind: "event"; name: string; payload: unknown };

export class PanelRuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PanelRuntimeError";
  }
}

function inferScope(scope: Record<string, ExprValue>): ExprScope {
  const out: ExprScope = {};
  for (const [k, v] of Object.entries(scope)) {
    if (typeof v === "number") out[k] = "number";
    else if (typeof v === "boolean") out[k] = "bool";
    else out[k] = "text";   // dates arrive as ISO text; comparable as text
  }
  return out;
}

type PanelMain = (clay: unknown) => unknown;

/**
 * Load the panel module. Browser path (doc 06 §2): Blob URL + dynamic
 * import under the srcdoc CSP (script-src 'unsafe-inline' blob:), with
 * h/components published as globals first. Test/jsdom fallback: a Function
 * wrapper with the same scope — identical semantics for the canonical
 * single-default-export panels the Validator enforces (V1).
 */
async function evaluatePanelModule(code: string): Promise<PanelMain> {
  const globals: Record<string, unknown> = { ...PANEL_GLOBALS, h };
  if (typeof URL !== "undefined" && typeof Blob !== "undefined"
      && typeof URL.createObjectURL === "function") {
    try {
      for (const [k, v] of Object.entries(globals))
        (globalThis as Record<string, unknown>)[k] = v;
      const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      try {
        const mod = await import(/* @vite-ignore */ url) as { default?: unknown };
        if (typeof mod.default !== "function")
          throw new PanelRuntimeError("E_RENDER", "module has no default function");
        return mod.default as PanelMain;
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      if (e instanceof PanelRuntimeError) throw e;
      // jsdom and older engines can't import blob modules — fall through
    }
  }
  const names = Object.keys(globals);
  const body = code.replace(/export\s+default/, "return ");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(...names, `"use strict";\n${body}`) as
    (...args: unknown[]) => unknown;
  const main = factory(...names.map(n => globals[n]));
  if (typeof main !== "function")
    throw new PanelRuntimeError("E_RENDER", "module has no default function");
  return main as PanelMain;
}

export type PanelRuntimeOptions = {
  port: PortLike;
  container: Element;
  /** Called when the panel module or a callback throws (boundary, doc 05 §7). */
  onPanelError?: (err: unknown) => void;
  /** ui.render must run within this window after boot (doc 03 §2). */
  renderTimeoutMs?: number;
};

export function bootPanelRuntime(opts: PanelRuntimeOptions): void {
  const { port, container } = opts;
  const renderTimeoutMs = opts.renderTimeoutMs ?? 2000;
  let rendered = false;
  const reportError = (err: unknown): void => {
    opts.onPanelError?.(err);
    // ADR-015: signal the boundary through the Bridge (validated, no reply)
    const code = err instanceof PanelRuntimeError ? err.code : "E_PANEL";
    const message = err instanceof Error ? err.message : String(err);
    try {
      port.send({ v: 1, kind: "panel_error", code: code.slice(0, 40),
        message: message.slice(0, 500) });
    } catch { /* port already torn down */ }
  };

  let booted = false;
  let panelId = "";
  let seq = 0;
  let lastHeight = -1;
  // Auto-height: after each render, tell the shell how tall the content is
  // so it can size the iframe to fit (no scrollbars, no wasted space). A
  // no-op under jsdom/tests (window.parent === window) and guarded against
  // resize churn (only report a meaningful change).
  const reportHeight = (): void => {
    try {
      const w = (typeof window !== "undefined" ? window : undefined) as
        (Window & typeof globalThis) | undefined;
      if (!w || w.parent === w) return;
      // Measure body.scrollHeight — the body's own content box INCLUDING its
      // padding, and (unlike documentElement) never clamped to the viewport,
      // so it shrinks as well as grows. Falls back to the container.
      const body = w.document.body;
      const height = Math.max(
        body ? body.scrollHeight : 0,
        (container as HTMLElement).scrollHeight || 0);
      if (height > 0 && Math.abs(height - lastHeight) > 2) {
        lastHeight = height;
        w.parent.postMessage(
          { v: 1, kind: "clay_resize", panelId, height }, "*");
      }
    } catch { /* sizing is best-effort */ }
  };
  // Content height settles AFTER the first render (fonts, select options,
  // wrapping) — a one-shot measure clips the bottom of the panel and leaves
  // e.g. a form's submit button under the shell's edge-resize strip. Track
  // it live. (jsdom has no ResizeObserver; render() still reports once.)
  try {
    if (typeof ResizeObserver !== "undefined" && typeof window !== "undefined"
        && window.parent !== window && window.document.body) {
      new ResizeObserver(() => reportHeight()).observe(window.document.body);
    }
  } catch { /* sizing is best-effort */ }
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  const watchCbs = new Map<string, (rows: Record<string, unknown>[]) => void>();
  const eventCbs = new Map<string, Set<(payload: unknown) => void>>();
  let watchN = 0;

  function call(name: string, args: unknown[]): Promise<unknown> {
    const s = seq++;
    return new Promise((resolve, reject) => {
      pending.set(s, { resolve, reject });
      port.send({ v: 1, panel: panelId, seq: s, call: name, args });
    });
  }

  function start(boot: BootMessage): void {
    panelId = boot.panelId;
    const meta = Object.freeze({
      schema: boot.meta.schema,
      panelId: boot.panelId,
      appVersion: boot.meta.appVersion,
      placement: boot.meta.placement,
    });

    const clay = {
      db: {
        query: (q: unknown) => call("db.query", [q]),
        watch: (q: unknown, cb: (rows: Record<string, unknown>[]) => void): (() => void) => {
          const watchId = `w${watchN++}`;
          watchCbs.set(watchId, cb);
          call("db.watch", [q, watchId]).catch(reportError);
          return () => {
            watchCbs.delete(watchId);
            call("db.unwatch", [watchId]).catch(() => {});
          };
        },
        insert: (table: unknown, row: unknown) => call("db.insert", [table, row]),
        update: (table: unknown, id: unknown, patch: unknown) =>
          call("db.update", [table, id, patch]),
        softDelete: (table: unknown, id: unknown) => call("db.softDelete", [table, id]),
      },
      ui: {
        render: (vnode: VChild): void => {
          rendered = true;
          render(vnode, container, { schema: boot.meta.schema as SchemaTable[] });
          reportHeight();
        },
        toast: (msg: unknown, kind?: unknown): void => {
          call("ui.toast", kind === undefined ? [msg] : [msg, kind]).catch(reportError);
        },
        confirm: (msg: unknown): Promise<unknown> => call("ui.confirm", [msg]),
      },
      events: {
        emit: (name: unknown, payload: unknown): void => {
          call("events.emit", [name, payload]).catch(reportError);
        },
        on: (name: string, cb: (payload: unknown) => void): (() => void) => {
          let set = eventCbs.get(name);
          if (!set) { set = new Set(); eventCbs.set(name, set); }
          set.add(cb);
          return () => { set.delete(cb); };
        },
      },
      compute: {
        eval: (expr: string, scope: Record<string, ExprValue> = {}): ExprValue => {
          const ast = parseExpr(expr);
          typecheckExpr(ast, inferScope(scope));
          return evalExpr(ast, scope);
        },
        now: (): string => new Date().toISOString(),
        daysBetween: (a: string, b: string): number | null => {
          const scope: Record<string, ExprValue> = { a, b };
          const { ast } = compileExpr("days_between(a, b)",
            { a: "date", b: "date" });
          const v = evalExpr(ast, scope);
          return typeof v === "number" ? v : null;
        },
        formatCurrency: (n: number, code = "USD"): string =>
          new Intl.NumberFormat(undefined, { style: "currency", currency: code }).format(n),
      },
      meta,
    };

    // E_RENDER_TIMEOUT (doc 03 §2): render must happen soon after boot.
    // The timer lives in the trusted bootstrap — V2 only bans timers in
    // panel code.
    setTimeout(() => {
      if (!rendered)
        reportError(new PanelRuntimeError("E_RENDER_TIMEOUT",
          `panel did not render within ${renderTimeoutMs}ms of boot`));
    }, renderTimeoutMs);

    // Evaluate the module with h + component markers in scope, then invoke.
    void (async () => {
      try {
        const main = await evaluatePanelModule(boot.code);
        main(clay);
      } catch (e) {
        reportError(e);
      }
    })();
  }

  port.onMessage((raw) => {
    const msg = raw as {
      kind?: string; seq?: number; ok?: boolean; result?: unknown;
      error?: { code: string; message: string };
    };
    if (msg.kind === "boot" && !booted) {
      booted = true;
      start(raw as BootMessage);
      return;
    }
    if (msg.kind === "watch") {
      const push = raw as Extract<Push, { kind: "watch" }>;
      try { watchCbs.get(push.watchId)?.(push.rows); }
      catch (e) { reportError(e); }
      return;
    }
    if (msg.kind === "event") {
      const push = raw as Extract<Push, { kind: "event" }>;
      for (const cb of eventCbs.get(push.name) ?? []) {
        try { cb(push.payload); } catch (e) { reportError(e); }
      }
      return;
    }
    if (typeof msg.seq === "number" && typeof msg.ok === "boolean") {
      const p = pending.get(msg.seq);
      if (!p) return;
      pending.delete(msg.seq);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new PanelRuntimeError(msg.error?.code ?? "E_INTERNAL",
        msg.error?.message ?? "call failed"));
    }
  });
}
