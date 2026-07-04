// Bridge: the ONLY code path where untrusted panel input meets trusted
// state (doc 06 §3). Every inbound message is Zod-validated; panel identity
// comes from WHICH PORT the message arrived on (the shell binds one port
// per iframe — the payload's `panel` field is only cross-checked); table
// access is checked against declared_queries (V4 runtime match, with
// {$var:true} wildcards) and declared_writes (G22/ADR-014); rate limits and
// strikes per doc 03/06.
import { BridgeCall, BridgePanelError } from "@clay/schema";
import { ClayError } from "./errors";
import type { AsyncStore, MessagePortLike } from "./asyncstore";
import type { RegTable } from "./registry";

type QueryT = import("@clay/schema").Query;

export type PanelManifest = {
  panelId: string;
  title: string;
  placement: { region: "top" | "main" | "side"; order: number };
  code: string;
  declaredQueries: QueryT[];
  declaredWrites: string[];
};

export type BridgeHooks = {
  onToast?: (panelId: string, msg: string, kind: string) => void;
  onConfirm?: (panelId: string, msg: string) => Promise<boolean>;
  /** Called when a panel trips its boundary (strikes, doc 06 §3). */
  onBoundary?: (panelId: string, reason: string) => void;
  /** Runtime failure reported from inside the iframe (ADR-015, doc 05 §7).
   * code/message are untrusted: display + repair input only. */
  onPanelError?: (panelId: string, code: string, message: string) => void;
};

export type BridgeLimits = {
  callsPerMin: number;
  maxWatches: number;
  emitsPerMin: number;
  maxEventPayload: number;
  confirmsPerMin: number;
  strikeLimit: number;
  debounceMs: number;
};

const DEFAULT_LIMITS: BridgeLimits = {
  callsPerMin: 60, maxWatches: 8, emitsPerMin: 20,
  maxEventPayload: 8192, confirmsPerMin: 5, strikeLimit: 10, debounceMs: 50,
};

/** Runtime V4 match: executed equals declared, except condition values the
 * declaration marks {"$var": true}, which accept any concrete value. */
export function queryMatchesDeclared(exec: unknown, declared: unknown): boolean {
  if (typeof declared === "object" && declared !== null && !Array.isArray(declared)
      && (declared as Record<string, unknown>).$var === true)
    return exec !== undefined;
  if (Array.isArray(declared) || Array.isArray(exec)) {
    if (!Array.isArray(declared) || !Array.isArray(exec)) return false;
    if (declared.length !== exec.length) return false;
    return declared.every((d, i) => queryMatchesDeclared(exec[i], d));
  }
  if (typeof declared === "object" && declared !== null) {
    if (typeof exec !== "object" || exec === null) return false;
    const keys = new Set([
      ...Object.keys(declared),
      ...Object.keys(exec as Record<string, unknown>),
    ]);
    for (const k of keys) {
      if (!queryMatchesDeclared(
        (exec as Record<string, unknown>)[k],
        (declared as Record<string, unknown>)[k])) return false;
    }
    return true;
  }
  return exec === declared;
}

type PanelState = {
  manifest: PanelManifest;
  port: MessagePortLike;
  callTimes: number[];
  emitTimes: number[];
  confirmTimes: number[];
  confirmOpen: boolean;
  strikes: number;
  tripped: boolean;
  watches: Map<string, { query: QueryT; table: string }>;
};

export class Bridge {
  private readonly panels = new Map<string, PanelState>();
  private readonly limits: BridgeLimits;
  private pendingTables = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private appVersion = 0;
  private tokens: Record<string, string> = {};

  constructor(
    private readonly store: AsyncStore,
    private readonly hooks: BridgeHooks = {},
    limits: Partial<BridgeLimits> = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  setAppContext(appVersion: number, tokens: Record<string, string>): void {
    this.appVersion = appVersion;
    this.tokens = tokens;
  }

  /** Wire a panel port and send its boot message (doc 06 §3, G21). */
  async attachPanel(manifest: PanelManifest, port: MessagePortLike): Promise<void> {
    const state: PanelState = {
      manifest, port, callTimes: [], emitTimes: [], confirmTimes: [],
      confirmOpen: false, strikes: 0, tripped: false, watches: new Map(),
    };
    this.panels.set(manifest.panelId, state);
    port.onMessage((raw) => { void this.handle(state, raw); });
    const schema: RegTable[] = await this.store.registryTables();
    port.send({
      v: 1, kind: "boot",
      code: manifest.code, panelId: manifest.panelId, apiVersion: 1,
      meta: { schema, appVersion: this.appVersion, placement: manifest.placement },
      tokens: this.tokens,
    });
  }

  detachPanel(panelId: string): void {
    this.panels.delete(panelId);   // watches die with the state (doc 03 §1)
  }

  /** Shell-side notification that a table changed (commits, data view). */
  notifyWrite(table: string): void {
    this.pendingTables.add(table);
    this.flushTimer ??= setTimeout(() => { void this.flushWatches(); }, this.limits.debounceMs);
  }

  private async flushWatches(): Promise<void> {
    this.flushTimer = null;
    const tables = this.pendingTables;
    this.pendingTables = new Set();
    for (const state of this.panels.values()) {
      for (const [watchId, w] of state.watches) {
        if (!tables.has(w.table)) continue;
        try {
          const rows = await this.store.query(w.query);
          state.port.send({ v: 1, kind: "watch", watchId, rows });
        } catch {
          /* watch queries were validated at registration; a failure here
             means the schema moved underneath — the panel swap handles it */
        }
      }
    }
  }

  private strike(state: PanelState, reason: string): void {
    state.strikes += 1;
    if (state.strikes >= this.limits.strikeLimit && !state.tripped) {
      state.tripped = true;
      this.hooks.onBoundary?.(state.manifest.panelId, reason);
    }
  }

  private static prune(times: number[], now: number): void {
    while (times.length > 0 && now - times[0]! > 60_000) times.shift();
  }

  private reply(state: PanelState, seq: number, result: unknown): void {
    state.port.send({ v: 1, seq, ok: true, result });
  }

  private replyError(state: PanelState, seq: number, code: string, message: string): void {
    state.port.send({ v: 1, seq, ok: false, error: { code, message } });
  }

  private matchDeclaredQuery(state: PanelState, q: unknown): boolean {
    return state.manifest.declaredQueries.some(d => queryMatchesDeclared(q, d));
  }

  private async handle(state: PanelState, raw: unknown): Promise<void> {
    if (state.tripped) return;
    const panelError = BridgePanelError.safeParse(raw);
    if (panelError.success) {
      this.hooks.onPanelError?.(state.manifest.panelId,
        panelError.data.code, panelError.data.message);
      return;   // not a call: no reply, no strike, no rate-limit charge
    }
    const parsed = BridgeCall.safeParse(raw);
    if (!parsed.success) { this.strike(state, "malformed message"); return; }
    const call = parsed.data;
    if (call.panel !== state.manifest.panelId) {
      this.strike(state, "forged panel id");   // port identity is authoritative
      return;
    }
    const now = Date.now();
    Bridge.prune(state.callTimes, now);
    if (state.callTimes.length >= this.limits.callsPerMin) {
      this.replyError(state, call.seq, "E_LIMIT", "call rate limit");
      return;
    }
    state.callTimes.push(now);

    try {
      switch (call.call) {
        case "db.query": {
          const [q] = call.args;
          if (!this.matchDeclaredQuery(state, q))
            throw new ClayError("E_VALIDATION", "query does not match any declared query (V4)");
          this.reply(state, call.seq, await this.store.query(q as QueryT));
          return;
        }
        case "db.watch": {
          const [q, watchId] = call.args;
          if (typeof watchId !== "string" || watchId.length > 40)
            throw new ClayError("E_VALIDATION", "bad watch id");
          if (!this.matchDeclaredQuery(state, q))
            throw new ClayError("E_VALIDATION", "watch does not match any declared query (V4)");
          if (state.watches.size >= this.limits.maxWatches)
            throw new ClayError("E_LIMIT", `max ${this.limits.maxWatches} watches per panel`);
          const query = q as QueryT;
          state.watches.set(watchId, { query, table: query.from });
          this.reply(state, call.seq, null);
          const rows = await this.store.query(query);
          state.port.send({ v: 1, kind: "watch", watchId, rows });
          return;
        }
        case "db.unwatch": {
          const [watchId] = call.args;
          if (typeof watchId === "string") state.watches.delete(watchId);
          this.reply(state, call.seq, null);
          return;
        }
        case "db.insert": case "db.update": case "db.softDelete": {
          const table = call.args[0];
          if (typeof table !== "string" || !state.manifest.declaredWrites.includes(table))
            throw new ClayError("E_VALIDATION",
              `table '${String(table)}' is not in declared_writes (ADR-014)`);
          if (call.call === "db.insert") {
            const row = await this.store.insert(table, (call.args[1] ?? {}) as Record<string, unknown>);
            this.notifyWrite(table);
            this.reply(state, call.seq, row);
          } else if (call.call === "db.update") {
            const row = await this.store.update(table, String(call.args[1]),
              (call.args[2] ?? {}) as Record<string, unknown>);
            this.notifyWrite(table);
            this.reply(state, call.seq, row);
          } else {
            await this.store.softDelete(table, String(call.args[1]));
            this.notifyWrite(table);
            this.reply(state, call.seq, null);
          }
          return;
        }
        case "ui.toast": {
          const [msg, kind] = call.args;
          if (typeof msg !== "string" || msg.length > 200)
            throw new ClayError("E_VALIDATION", "bad toast");
          this.hooks.onToast?.(state.manifest.panelId, msg,
            typeof kind === "string" ? kind : "default");
          this.reply(state, call.seq, null);
          return;
        }
        case "ui.confirm": {
          const [msg] = call.args;
          if (typeof msg !== "string" || msg.length > 200)
            throw new ClayError("E_VALIDATION", "bad confirm");
          Bridge.prune(state.confirmTimes, now);
          if (state.confirmOpen || state.confirmTimes.length >= this.limits.confirmsPerMin)
            throw new ClayError("E_LIMIT", "confirm rate limit (1 concurrent, 5/min)");
          state.confirmTimes.push(now);
          state.confirmOpen = true;
          try {
            const answer = this.hooks.onConfirm
              ? await this.hooks.onConfirm(state.manifest.panelId, msg)
              : false;
            this.reply(state, call.seq, answer);
          } finally {
            state.confirmOpen = false;
          }
          return;
        }
        case "events.emit": {
          const [name, payload] = call.args;
          if (typeof name !== "string" || !/^[a-z][a-z0-9_]{0,40}$/.test(name))
            throw new ClayError("E_VALIDATION", "bad event name");
          if (JSON.stringify(payload ?? null).length > this.limits.maxEventPayload)
            throw new ClayError("E_LIMIT", "event payload over 8KB");
          Bridge.prune(state.emitTimes, now);
          if (state.emitTimes.length >= this.limits.emitsPerMin)
            throw new ClayError("E_LIMIT", "emit rate limit");
          state.emitTimes.push(now);
          this.reply(state, call.seq, null);
          for (const other of this.panels.values())
            other.port.send({ v: 1, kind: "event", name, payload: payload ?? null });
          return;
        }
        case "events.on": case "events.off":
          // event delivery is broadcast; subscription filtering is client-local
          this.reply(state, call.seq, null);
          return;
      }
    } catch (e) {
      if (e instanceof ClayError) this.replyError(state, call.seq, e.code, e.message);
      else this.replyError(state, call.seq, "E_INTERNAL", "internal error");
    }
  }
}
