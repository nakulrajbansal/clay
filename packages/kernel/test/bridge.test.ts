// Bridge tests: the densest coverage in the repo belongs here (doc 06 §3).
// Fake in-process ports; a real ClayStore underneath.
import { describe, expect, it } from "vitest";
import {
  Bridge, InProcessAsyncStore, queryMatchesDeclared,
  type MessagePortLike, type PanelManifest, type Query,
} from "../src/index";
import { seededStore } from "./helpers";

function portPair(): [MessagePortLike, MessagePortLike] {
  let cbA: ((m: unknown) => void) | null = null;
  let cbB: ((m: unknown) => void) | null = null;
  const a: MessagePortLike = {
    send: (m) => queueMicrotask(() => cbB?.(m)),
    onMessage: (cb) => { cbA = cb; },
  };
  const b: MessagePortLike = {
    send: (m) => queueMicrotask(() => cbA?.(m)),
    onMessage: (cb) => { cbB = cb; },
  };
  return [a, b];
}

/** Minimal panel-side client for driving the bridge in tests. */
function client(port: MessagePortLike, panelId: string): {
  call: (call: string, args: unknown[]) => Promise<unknown>;
  send: (raw: unknown) => void;
  messages: unknown[];
} {
  let seq = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  const messages: unknown[] = [];
  port.onMessage((raw) => {
    messages.push(raw);
    const m = raw as { seq?: number; ok?: boolean; result?: unknown; error?: { code: string } };
    if (typeof m.seq === "number" && typeof m.ok === "boolean") {
      const p = pending.get(m.seq);
      if (!p) return;
      pending.delete(m.seq);
      if (m.ok) p.resolve(m.result);
      else p.reject(m.error);
    }
  });
  return {
    messages,
    send: (raw) => port.send(raw),
    call: (call, args) => {
      const s = seq++;
      return new Promise((resolve, reject) => {
        pending.set(s, { resolve, reject });
        port.send({ v: 1, panel: panelId, seq: s, call, args });
      });
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

const STRIP_QUERY: Query = {
  from: "projects",
  where: [{ field: "status", op: "eq", value: "red" }],
};

function manifest(over: Partial<PanelManifest> = {}): PanelManifest {
  return {
    panelId: "test_panel", title: "Test",
    placement: { region: "main", order: 0 }, code: "export default function(clay){}",
    declaredQueries: [STRIP_QUERY], declaredWrites: [],
    ...over,
  };
}

async function setup(over: Partial<PanelManifest> = {}, limits = {}, hooks = {}): Promise<{
  bridge: Bridge; c: ReturnType<typeof client>;
  store: Awaited<ReturnType<typeof seededStore>>;
}> {
  const store = await seededStore();
  const bridge = new Bridge(new InProcessAsyncStore(store), hooks, limits);
  const [bridgeSide, panelSide] = portPair();
  const m = manifest(over);
  const c = client(panelSide, m.panelId);
  await bridge.attachPanel(m, bridgeSide);
  await sleep(1);
  return { bridge, c, store };
}

describe("boot", () => {
  it("sends the boot message with meta.schema (G21)", async () => {
    const { c, store } = await setup();
    const boot = c.messages.find(m => (m as { kind?: string }).kind === "boot") as {
      meta: { schema: unknown[]; appVersion: number }; tokens: object;
    };
    expect(boot).toBeDefined();
    expect(boot.meta.schema).toHaveLength(1);
    expect(boot.tokens).toEqual({});
    store.close();
  });
});

describe("declared query enforcement (V4 runtime)", () => {
  it("matching query passes; undeclared shape is rejected", async () => {
    const { c, store } = await setup();
    const rows = await c.call("db.query", [STRIP_QUERY]) as unknown[];
    expect(rows).toHaveLength(1);
    await expect(c.call("db.query", [{ from: "projects" }]))
      .rejects.toMatchObject({ code: "E_VALIDATION" });
    await expect(c.call("db.query", [{ from: "projects",
      where: [{ field: "status", op: "eq", value: "green" }] }]))
      .rejects.toMatchObject({ code: "E_VALIDATION" });
    store.close();
  });

  it("{$var:true} declarations accept any concrete value", async () => {
    const declared: Query = { from: "projects",
      where: [{ field: "owner", op: "eq", value: { $var: true } }] };
    const { c, store } = await setup({ declaredQueries: [declared] });
    const rows = await c.call("db.query", [{ from: "projects",
      where: [{ field: "owner", op: "eq", value: "Dev" }] }]) as unknown[];
    expect(rows).toHaveLength(2);
    // but the condition itself cannot be dropped
    await expect(c.call("db.query", [{ from: "projects" }]))
      .rejects.toMatchObject({ code: "E_VALIDATION" });
    store.close();
  });
});

describe("write enforcement (ADR-014)", () => {
  it("writes require declared_writes membership", async () => {
    const { c, store } = await setup({ declaredWrites: ["projects"] });
    const row = await c.call("db.insert", ["projects",
      { name: "Denali", status: "red" }]) as { id: string; name: string };
    expect(row.name).toBe("Denali");
    await expect(c.call("db.update", ["nope", row.id, { name: "X" }]))
      .rejects.toMatchObject({ code: "E_VALIDATION" });
    store.close();
  });

  it("bridge-mediated writes push fresh rows to watches (debounced)", async () => {
    const { c, store } = await setup({ declaredWrites: ["projects"] });
    await c.call("db.watch", [STRIP_QUERY, "w0"]);
    await sleep(5);
    const pushes = (): number[] => c.messages
      .filter(m => (m as { kind?: string }).kind === "watch")
      .map(m => (m as { rows: unknown[] }).rows.length);
    expect(pushes()).toEqual([1]);          // initial rows
    await c.call("db.insert", ["projects", { name: "Denali", status: "red" }]);
    await sleep(80);                        // > debounce 50ms
    expect(pushes()).toEqual([1, 2]);
    store.close();
  });
});

describe("limits and strikes", () => {
  it("watch cap trips E_LIMIT", async () => {
    const { c, store } = await setup({}, { maxWatches: 1 });
    await c.call("db.watch", [STRIP_QUERY, "w0"]);
    await expect(c.call("db.watch", [STRIP_QUERY, "w1"]))
      .rejects.toMatchObject({ code: "E_LIMIT" });
    store.close();
  });

  it("call rate limit trips E_LIMIT", async () => {
    const { c, store } = await setup({}, { callsPerMin: 2 });
    await c.call("db.query", [STRIP_QUERY]);
    await c.call("db.query", [STRIP_QUERY]);
    await expect(c.call("db.query", [STRIP_QUERY]))
      .rejects.toMatchObject({ code: "E_LIMIT" });
    store.close();
  });

  it("malformed messages strike; the boundary trips at the limit", async () => {
    let tripped: string | null = null;
    const { c, store } = await setup({}, { strikeLimit: 3 },
      { onBoundary: (id: string) => { tripped = id; } });
    c.send({ garbage: true });
    c.send(42);
    c.send({ v: 1, panel: "forged_other", seq: 0, call: "db.query", args: [] });
    await sleep(5);
    expect(tripped).toBe("test_panel");
    // tripped panels are ignored entirely
    c.send({ v: 1, panel: "test_panel", seq: 99, call: "db.query", args: [STRIP_QUERY] });
    await sleep(5);
    expect(c.messages.filter(m => (m as { seq?: number }).seq === 99)).toHaveLength(0);
    store.close();
  });

  it("panel_error pushes reach the hook without a strike (ADR-015)", async () => {
    const faults: string[] = [];
    let tripped = false;
    const { c, store } = await setup({}, { strikeLimit: 2 }, {
      onPanelError: (id: string, code: string, msg: string) =>
        faults.push(`${id}/${code}/${msg}`),
      onBoundary: () => { tripped = true; },
    });
    c.send({ v: 1, kind: "panel_error", code: "E_RENDER_TIMEOUT", message: "no render" });
    c.send({ v: 1, kind: "panel_error", code: "E_PANEL", message: "boom" });
    await sleep(5);
    expect(faults).toEqual([
      "test_panel/E_RENDER_TIMEOUT/no render",
      "test_panel/E_PANEL/boom",
    ]);
    expect(tripped).toBe(false);   // two malformed messages would have tripped
    // and calls still work afterwards
    expect(await c.call("db.query", [STRIP_QUERY])).toHaveLength(1);
    store.close();
  });

  it("events: payload cap and name validation", async () => {
    const { c, store } = await setup({}, { maxEventPayload: 64 });
    await c.call("events.emit", ["board_filter", { owner: "Dev" }]);
    const evt = c.messages.find(m => (m as { kind?: string }).kind === "event") as {
      name: string; payload: unknown;
    };
    expect(evt).toMatchObject({ name: "board_filter", payload: { owner: "Dev" } });
    await expect(c.call("events.emit", ["board_filter", { big: "x".repeat(200) }]))
      .rejects.toMatchObject({ code: "E_LIMIT" });
    await expect(c.call("events.emit", ["NOT_AN_IDENT", {}]))
      .rejects.toMatchObject({ code: "E_VALIDATION" });
    store.close();
  });
});

describe("queryMatchesDeclared", () => {
  const declared = { from: "t_one", where: [{ field: "a", op: "eq", value: { $var: true } }] };
  it.each([
    [{ from: "t_one", where: [{ field: "a", op: "eq", value: 1 }] }, true],
    [{ from: "t_one", where: [{ field: "a", op: "eq", value: "x" }] }, true],
    [{ from: "t_one", where: [{ field: "a", op: "neq", value: 1 }] }, false],
    [{ from: "t_one", where: [{ field: "b", op: "eq", value: 1 }] }, false],
    [{ from: "t_two", where: [{ field: "a", op: "eq", value: 1 }] }, false],
    [{ from: "t_one" }, false],
    [{ from: "t_one", where: [{ field: "a", op: "eq", value: 1 }], limit: 9 }, false],
  ])("%j -> %s", (exec, want) => {
    expect(queryMatchesDeclared(exec, declared)).toBe(want);
  });
});
