// @vitest-environment jsdom
// W1 EXIT (doc 09): one hand-written panel through the real Bridge +
// PanelRuntime rendering real data — the doc 03 §7 canonical panel over a
// real ClayStore, wired through the Bridge protocol.
import { describe, expect, it } from "vitest";
import {
  Bridge, ClayStore, InProcessAsyncStore,
  type MessagePortLike, type PanelManifest, type Query,
} from "@clay/kernel";
import { bootPanelRuntime } from "../src/index";

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

async function seeded(rows: Record<string, unknown>[]): Promise<ClayStore> {
  const store = await ClayStore.openMemory();
  store.commit({
    intent: "seed", summary: "Creates projects.",
    migration: {
      operations: [{
        op: "create_table", table: "projects",
        columns: [
          { name: "name", type: "text", required: true },
          { name: "owner", type: "text", required: false },
          { name: "slipped_milestones", type: "integer", required: false },
          { name: "open_risks", type: "integer", required: false },
        ],
      }],
      inverse: [{ op: "drop_table_if_created_by_this", table: "projects" }],
    },
  });
  store.commit({
    intent: "health", summary: "Adds health score.",
    migration: {
      operations: [{ op: "create_computed", table: "projects", column: "health_score",
        expr: "100 - 10 * slipped_milestones - 5 * open_risks" }],
      inverse: [{ op: "drop_column_if_added_by_this", table: "projects", column: "health_score" }],
    },
  });
  for (const r of rows) store.insert("projects", r);
  return store;
}

// The doc 03 §7 worked example, verbatim in style (backticks escaped).
const HEALTH_PANEL_CODE = `export default function (clay) {
  const q = {
    from: "projects",
    where: [{ field: "health_score", op: "lt", value: 60 }],
    orderBy: [{ field: "health_score", dir: "asc" }],
  };
  clay.db.watch(q, (rows) => {
    clay.ui.render(
      h("section", {},
        rows.length === 0
          ? h(EmptyState, { label: "All projects healthy" })
          : h(Stack, {},
              h(Badge, { tone: "warning",
                         label: \`Needs attention: \${rows.length}\` }),
              h(Table, {
                columns: [
                  { field: "name", label: "Project" },
                  { field: "owner", label: "Owner" },
                  { field: "health_score", label: "Health",
                    badge: { field: "health_score",
                             map: { "<60": "red", "<80": "amber",
                                    ">=80": "green" } } },
                ],
                rows,
              }))));
  });
}`;

const STRIP_QUERY: Query = {
  from: "projects",
  where: [{ field: "health_score", op: "lt", value: 60 }],
  orderBy: [{ field: "health_score", dir: "asc" }],
};

function healthManifest(): PanelManifest {
  return {
    panelId: "health_alerts", title: "Needs attention",
    placement: { region: "top", order: 1 },
    code: HEALTH_PANEL_CODE,
    declaredQueries: [STRIP_QUERY], declaredWrites: [],
  };
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms)
      throw new Error(`timeout waiting; DOM: ${document.body.innerHTML}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

function mount(): HTMLElement {
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  return container;
}

describe("W1: hand-written panel through the real Bridge", () => {
  it("renders real store data, and re-renders on writes", async () => {
    const store = await seeded([
      { name: "Apollo", owner: "Dev", slipped_milestones: 0, open_risks: 1 },   // 95
      { name: "Borealis", owner: "Kim", slipped_milestones: 2, open_risks: 3 }, // 65
      { name: "Cygnus", owner: "Dev", slipped_milestones: 4, open_risks: 5 },   // 35
    ]);
    const bridge = new Bridge(new InProcessAsyncStore(store));
    const [bridgeSide, panelSide] = portPair();
    const container = mount();
    const errors: unknown[] = [];
    bootPanelRuntime({ port: panelSide, container, onPanelError: e => errors.push(e) });
    await bridge.attachPanel(healthManifest(), bridgeSide);

    await waitFor(() => container.textContent!.includes("Cygnus"));
    expect(container.textContent).toContain("Needs attention: 1");
    expect(container.textContent).not.toContain("Apollo");
    // threshold badge map: 35 -> "<60" -> red (G25)
    const badges = [...container.querySelectorAll("td .clay-badge")];
    expect(badges.map(b => b.className)).toContain("clay-badge clay-tone-red");

    // a write lands; the watch pushes fresh rows after the 50ms debounce
    store.insert("projects", { name: "Icarus", owner: "Sol", slipped_milestones: 5, open_risks: 5 }); // 25
    bridge.notifyWrite("projects");
    await waitFor(() => container.textContent!.includes("Icarus"));
    expect(container.textContent).toContain("Needs attention: 2");
    // ordered by health ascending: Icarus (25) before Cygnus (35)
    const names = [...container.querySelectorAll("tbody tr td:first-child")].map(td => td.textContent);
    expect(names).toEqual(["Icarus", "Cygnus"]);

    expect(errors).toEqual([]);
    store.close();
  });

  it("renders the empty state when nothing is flagged", async () => {
    const store = await seeded([
      { name: "Apollo", owner: "Dev", slipped_milestones: 0, open_risks: 0 },   // 100
    ]);
    const bridge = new Bridge(new InProcessAsyncStore(store));
    const [bridgeSide, panelSide] = portPair();
    const container = mount();
    bootPanelRuntime({ port: panelSide, container });
    await bridge.attachPanel(healthManifest(), bridgeSide);
    await waitFor(() => container.textContent!.includes("All projects healthy"));
    store.close();
  });

  it("clay.compute.eval runs sync inside the runtime (G20)", async () => {
    const store = await seeded([]);
    const bridge = new Bridge(new InProcessAsyncStore(store));
    const [bridgeSide, panelSide] = portPair();
    const container = mount();
    bootPanelRuntime({ port: panelSide, container });
    await bridge.attachPanel({
      panelId: "calc_panel", title: "Calc",
      placement: { region: "main", order: 0 },
      code: `export default function (clay) {
        const v = clay.compute.eval("1 + 2 * a", { a: 5 });
        clay.ui.render(h("p", {}, "result: " + v, " / ", clay.compute.formatCurrency(3)));
      }`,
      declaredQueries: [], declaredWrites: [],
    }, bridgeSide);
    await waitFor(() => container.textContent!.includes("result: 11"));
    store.close();
  });

  it("undeclared queries are refused end-to-end", async () => {
    const store = await seeded([
      { name: "Apollo", owner: "Dev", slipped_milestones: 0, open_risks: 1 },
    ]);
    const bridge = new Bridge(new InProcessAsyncStore(store));
    const [bridgeSide, panelSide] = portPair();
    const container = mount();
    bootPanelRuntime({ port: panelSide, container });
    await bridge.attachPanel({
      panelId: "sneaky_panel", title: "Sneaky",
      placement: { region: "main", order: 0 },
      code: `export default function (clay) {
        clay.db.query({ from: "projects" })
          .then(() => clay.ui.render(h("p", {}, "got data")))
          .catch((e) => clay.ui.render(h("p", {}, "denied: " + e.code)));
      }`,
      declaredQueries: [STRIP_QUERY], declaredWrites: [],
    }, bridgeSide);
    await waitFor(() => container.textContent!.includes("denied: E_VALIDATION"));
    store.close();
  });
});
