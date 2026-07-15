// @vitest-environment jsdom
// G9: seed panels are WORKING panels — every one boots through the real
// Bridge against its seeded store and renders real data, and the forms
// write back through declared_writes.
import { describe, expect, it } from "vitest";
import {
  Bridge, ClayStore, InProcessAsyncStore,
  type MessagePortLike,
} from "@clay/kernel";
import { bootPanelRuntime } from "@clay/panel-runtime";
import { SEED_PANELS, STARTER_SHELLS, seedStarterShell, type StarterShellId } from "../src/index";

function portPair(): [MessagePortLike, MessagePortLike] {
  let cbA: ((m: unknown) => void) | null = null;
  let cbB: ((m: unknown) => void) | null = null;
  return [
    { send: m => queueMicrotask(() => cbB?.(m)), onMessage: cb => { cbA = cb; } },
    { send: m => queueMicrotask(() => cbA?.(m)), onMessage: cb => { cbB = cb; } },
  ];
}

async function waitFor(cond: () => boolean, what: string, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms)
      throw new Error(`timeout waiting for ${what}; DOM: ${document.body.innerHTML}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

type Booted = {
  store: ClayStore; bridge: Bridge; container: HTMLElement;
  toasts: string[]; errors: unknown[];
};

async function bootShellPanel(shellId: StarterShellId, panelId: string): Promise<Booted> {
  const store = await ClayStore.openMemory();
  seedStarterShell(store, shellId);
  const toasts: string[] = [];
  const errors: unknown[] = [];
  const bridge = new Bridge(new InProcessAsyncStore(store), {
    onToast: (_p, msg, kind) => toasts.push(`${kind}:${msg}`),
  });
  const panel = SEED_PANELS[shellId]!.find(p => p.panel_id === panelId)!;
  const [bridgeSide, panelSide] = portPair();
  const container = document.createElement("div");
  document.body.appendChild(container);
  bootPanelRuntime({ port: panelSide, container, onPanelError: e => errors.push(e) });
  await bridge.attachPanel({
    panelId: panel.panel_id, title: panel.title, placement: panel.placement,
    code: panel.code, declaredQueries: panel.declared_queries,
    declaredWrites: panel.declared_writes,
  }, bridgeSide);
  return { store, bridge, container, toasts, errors };
}

describe("every seed panel boots and renders real data", () => {
  const expectations: [StarterShellId, string, (c: HTMLElement) => boolean][] = [
    ["tracker", "items_table", c => c.textContent!.includes("Ship the deck")],
    ["tracker", "status_counts", c =>
      c.textContent!.includes("doing") && c.querySelectorAll(".clay-metric").length === 3],
    ["tracker", "add_item_form", c =>
      c.querySelectorAll("form.clay-form input, form.clay-form select").length === 4],
    ["log", "entries_table", c => c.textContent!.includes("Morning run")],
    ["log", "per_week_chart", c => c.querySelectorAll(".clay-chart-bar").length >= 1],
    ["log", "quick_add_form", c => c.querySelector("form.clay-form") !== null],
    ["dashboard", "metrics_row", c =>
      c.textContent!.includes("Records") && c.textContent!.includes("5")],
    ["dashboard", "records_table", c => c.textContent!.includes("Website refresh")],
    ["dashboard", "by_category_chart", c => c.querySelectorAll(".clay-chart-bar").length === 3],
    // small business — one dataset seen many ways
    ["small_business", "sb_dashboard", c =>
      c.textContent!.includes("Open jobs") && c.querySelectorAll(".clay-metric").length === 3],
    ["small_business", "sb_jobs_board", c =>
      c.querySelectorAll(".clay-board-col").length === 5 && c.textContent!.includes("Kitchen faucet fix")],
    ["small_business", "sb_jobs_table", c => c.textContent!.includes("Water heater install")],
    ["small_business", "sb_revenue", c => c.querySelectorAll(".clay-chart-bar").length >= 1],
    ["small_business", "sb_invoices", c => c.querySelectorAll("tbody tr").length === 3],
    ["small_business", "sb_customers", c =>
      c.querySelectorAll(".clay-card").length === 3 && c.textContent!.includes("Alice Nguyen")],
    ["small_business", "sb_upcoming", c => c.querySelector("table, .clay-empty") !== null],
    ["small_business", "sb_add_job", c =>
      c.querySelectorAll("form.clay-form input, form.clay-form select").length === 5],
    // CRM (Pipedrive-grade: 6 stages, weighted pipeline, follow-ups, forecast)
    ["crm", "crm_pipeline", c =>
      c.querySelectorAll(".clay-board-col").length === 6 && c.textContent!.includes("Northwind annual plan")],
    ["crm", "crm_metrics", c =>
      c.textContent!.includes("Weighted pipeline") && c.querySelectorAll(".clay-metric").length === 4],
    ["crm", "crm_today", c => c.textContent!.includes("Follow up on proposal")],
    ["crm", "crm_forecast", c => c.querySelectorAll(".clay-chart-bar").length >= 1],
    ["crm", "crm_contacts", c => c.querySelectorAll(".clay-card").length === 3],
    ["crm", "crm_add_task", c =>
      c.querySelectorAll("form.clay-form input, form.clay-form select").length === 4],
    // Financials
    ["financials", "fin_summary", c =>
      c.textContent!.includes("Net") && c.querySelectorAll(".clay-metric").length === 3],
    ["financials", "fin_transactions", c => c.querySelectorAll("tbody tr").length === 4],
    ["financials", "fin_spending", c => c.querySelectorAll(".clay-chart-bar").length >= 1],
    // Staff
    ["staff", "staff_board", c =>
      c.querySelectorAll(".clay-board-col").length === 3 && c.textContent!.includes("Maya Chen")],
    ["staff", "staff_roster", c => c.querySelectorAll(".clay-card").length === 3],
    ["staff", "staff_timeoff", c => c.querySelectorAll("tbody tr").length === 2],
    // Approvals — the workflow template (ADR-024): a Flow with 4 ordered
    // stages, advance buttons, and progress toward "paid"
    ["approvals", "request_flow", c =>
      c.querySelectorAll(".clay-flow-step").length === 4
      && c.querySelectorAll(".clay-flow-item").length === 5
      && c.querySelectorAll(".clay-flow-advance").length >= 1
      && c.textContent!.includes("Standing desk")],
    ["approvals", "approvals_overview", c =>
      c.textContent!.includes("Awaiting review") && c.querySelectorAll(".clay-metric").length === 4],
    ["approvals", "requests_table", c => c.querySelectorAll("tbody tr").length === 5],
    ["approvals", "new_request_form", c =>
      c.querySelectorAll("form.clay-form input, form.clay-form select").length === 4],
  ];

  for (const [shellId, panelId, check] of expectations) {
    it(`${shellId}/${panelId}`, async () => {
      const { store, container, errors } = await bootShellPanel(shellId, panelId);
      await waitFor(() => check(container), panelId);
      expect(errors).toEqual([]);
      store.close();
      document.body.replaceChildren();
    });
  }
});

describe("template interactivity: DRAG a card between columns (bidirectional, end-to-end)", () => {
  // simulate an HTML5 drag of a card onto the column whose label === toLabel
  const dragCardTo = (container: HTMLElement, cardText: string, toLabel: string): void => {
    const card = [...container.querySelectorAll<HTMLElement>(".clay-card")]
      .find(c => c.textContent!.includes(cardText))!;
    const col = [...container.querySelectorAll<HTMLElement>(".clay-board-col")]
      .find(c => c.querySelector(".clay-board-label")?.textContent === toLabel)!;
    card.dispatchEvent(new window.Event("dragstart", { bubbles: true }));
    col.dispatchEvent(new window.Event("drop", { bubbles: true }));
  };

  it("CRM: dragging a deal to another stage updates it and re-renders — and back again", async () => {
    const { store, container } = await bootShellPanel("crm", "crm_pipeline");
    await waitFor(() => container.textContent!.includes("Northwind annual plan"), "board");
    const cards = [...container.querySelectorAll<HTMLElement>(".clay-card")];
    expect(cards[0]!.getAttribute("draggable")).toBe("true");   // draggable, not click-to-advance

    dragCardTo(container, "Northwind annual plan", "won");       // proposal -> won
    await waitFor(() => store.query({ from: "deals",
      where: [{ field: "title", op: "eq", value: "Northwind annual plan" }] })[0]?.stage
      === "won", "moved to won");
    await waitFor(() => {
      const won = [...container.querySelectorAll(".clay-board-col")]
        .find(c => c.querySelector(".clay-board-label")?.textContent === "won");
      return won?.textContent?.includes("Northwind annual plan") ?? false;
    }, "card in won column");

    // bidirectional: drag it back to lead
    dragCardTo(container, "Northwind annual plan", "lead");
    await waitFor(() => store.query({ from: "deals",
      where: [{ field: "title", op: "eq", value: "Northwind annual plan" }] })[0]?.stage
      === "lead", "moved back to lead");
    store.close();
    document.body.replaceChildren();
  });

  it("Small Business: dragging a job between board columns updates its stage", async () => {
    const { store, container } = await bootShellPanel("small_business", "sb_jobs_board");
    await waitFor(() => container.textContent!.includes("Kitchen faucet fix"), "board");
    dragCardTo(container, "Kitchen faucet fix", "done");         // scheduled -> done
    await waitFor(() => store.query({ from: "jobs",
      where: [{ field: "title", op: "eq", value: "Kitchen faucet fix" }] })[0]?.status
      === "done", "job moved to done");
    store.close();
    document.body.replaceChildren();
  });

  it("Bookkeeping: dragging an invoice to 'paid' updates it", async () => {
    const { store, container } = await bootShellPanel("financials", "fin_invoices");
    await waitFor(() => container.textContent!.includes("Northwind"), "invoices board");
    dragCardTo(container, "Northwind", "paid");                  // sent -> paid
    await waitFor(() => store.query({ from: "invoices",
      where: [{ field: "customer", op: "eq", value: "Northwind" }] })[0]?.status
      === "paid", "invoice paid");
    store.close();
    document.body.replaceChildren();
  });

});

describe("forms write through declared_writes end-to-end", () => {
  it("add_item_form inserts an item and re-renders the watchers", async () => {
    const { store, container, toasts } = await bootShellPanel("tracker", "add_item_form");
    await waitFor(() => container.querySelector("form.clay-form") !== null, "form");

    const name = container.querySelector<HTMLInputElement>('input[name="name"]')!;
    name.value = "Test the seed form";
    const status = container.querySelector<HTMLSelectElement>('select[name="status"]')!;
    // fromSchema resolved the enum options from the boot registry (G25)
    expect([...status.options].map(o => o.value)).toEqual(["", "todo", "doing", "done"]);
    status.value = "todo";
    container.querySelector("form")!.dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }));

    await waitFor(() => toasts.length > 0, "toast");
    expect(toasts[0]).toBe("success:Item added");
    const rows = store.query({ from: "items" });
    expect(rows.map(r => r.name)).toContain("Test the seed form");
    store.close();
    document.body.replaceChildren();
  });
});
