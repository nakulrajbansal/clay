// The hand-written seed panels for the three starter shells (G9).
// Ids and placements are BINDING per specs/shells/starter-shells.json
// (a drift test compares). Every panel must pass the Validator and boot
// against its seeded store — both are tested, so the first-run promise
// (US-01, zero network) is CI-backed.
import type { PanelBlobInput } from "@clay/kernel";

// ---------- tracker ----------
const items_table: PanelBlobInput = {
  panel_id: "items_table", title: "Items",
  placement: { region: "main", order: 1 },
  declared_queries: [{ from: "items" }],
  declared_writes: [],
  code: `export default function (clay) {
  clay.db.watch({ from: "items" }, (rows) => {
    clay.ui.render(rows.length === 0
      ? h(EmptyState, { label: "No items yet - add one on the right" })
      : h(Table, { sortable: true, rows, columns: [
          { field: "name", label: "Name" },
          { field: "owner", label: "Owner" },
          { field: "status", label: "Status",
            badge: { field: "status", map: { todo: "gray", doing: "amber", done: "green" } } },
          { field: "due", label: "Due", format: "date" }] }));
  });
}`,
};

const status_counts: PanelBlobInput = {
  panel_id: "status_counts", title: "Status",
  placement: { region: "top", order: 0 },
  declared_queries: [{
    from: "items", groupBy: ["status"],
    aggregate: [{ fn: "count", field: "status", as: "n" }],
  }],
  declared_writes: [],
  code: `export default function (clay) {
  const q = { from: "items", groupBy: ["status"], aggregate: [{ fn: "count", field: "status", as: "n" }] };
  clay.db.watch(q, (rows) => {
    clay.ui.render(rows.length === 0
      ? h(EmptyState, { label: "Counts appear once you add items" })
      : h(Grid, {}, rows.map((r) => h(MetricCard, { label: String(r.status), value: r.n }))));
  });
}`,
};

const add_item_form: PanelBlobInput = {
  panel_id: "add_item_form", title: "Add item",
  placement: { region: "side", order: 0 },
  declared_queries: [],
  declared_writes: ["items"],
  code: `export default function (clay) {
  clay.ui.render(h(Form, {
    submitLabel: "Add item",
    fields: [
      { name: "name", label: "Name", kind: "text", required: true },
      { name: "owner", label: "Owner", kind: "text" },
      { name: "status", label: "Status", kind: "select", fromSchema: "items.status" },
      { name: "due", label: "Due", kind: "date" }],
    onSubmit: async (v) => {
      try {
        await clay.db.insert("items", v);
        clay.ui.toast("Item added", "success");
      } catch (e) {
        clay.ui.toast("Could not add: " + e.message, "danger");
      }
    } }));
}`,
};

// ---------- log ----------
const entries_table: PanelBlobInput = {
  panel_id: "entries_table", title: "Entries",
  placement: { region: "main", order: 0 },
  declared_queries: [{ from: "entries", orderBy: [{ field: "on", dir: "desc" }] }],
  declared_writes: [],
  code: `export default function (clay) {
  clay.db.watch({ from: "entries", orderBy: [{ field: "on", dir: "desc" }] }, (rows) => {
    clay.ui.render(rows.length === 0
      ? h(EmptyState, { label: "Log your first entry on the right" })
      : h(Table, { sortable: true, rows, columns: [
          { field: "title", label: "Entry" },
          { field: "on", label: "When", format: "date" },
          { field: "amount", label: "Amount", format: "number" },
          { field: "rating", label: "Rating" }] }));
  });
}`,
};

const per_week_chart: PanelBlobInput = {
  panel_id: "per_week_chart", title: "Per week",
  placement: { region: "main", order: 1 },
  declared_queries: [{ from: "entries", select: ["on"] }],
  declared_writes: [],
  code: `export default function (clay) {
  const q = { from: "entries", select: ["on"] };
  clay.db.watch(q, (rows) => {
    const byWeek = {};
    for (const r of rows) {
      const d = new Date(r.on);
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      const wk = d.toISOString().slice(0, 10);
      byWeek[wk] = (byWeek[wk] || 0) + 1;
    }
    const data = Object.keys(byWeek).sort().map((wk) => ({ x: wk, y: byWeek[wk] }));
    clay.ui.render(data.length === 0
      ? h(EmptyState, { label: "Add an entry to see your week" })
      : h(Chart, { kind: "bar", data, xLabel: "Week", yLabel: "Entries", height: 200 }));
  });
}`,
};

const quick_add_form: PanelBlobInput = {
  panel_id: "quick_add_form", title: "Quick add",
  placement: { region: "side", order: 0 },
  declared_queries: [],
  declared_writes: ["entries"],
  code: `export default function (clay) {
  clay.ui.render(h(Form, {
    submitLabel: "Add entry",
    fields: [
      { name: "title", label: "Title", kind: "text", required: true },
      { name: "on", label: "When", kind: "date", required: true },
      { name: "amount", label: "Amount", kind: "number" },
      { name: "rating", label: "Rating (1-5)", kind: "number" }],
    onSubmit: async (v) => {
      try {
        await clay.db.insert("entries", v);
        clay.ui.toast("Entry added", "success");
      } catch (e) {
        clay.ui.toast("Could not add: " + e.message, "danger");
      }
    } }));
}`,
};

// ---------- dashboard ----------
const metrics_row: PanelBlobInput = {
  panel_id: "metrics_row", title: "The numbers",
  placement: { region: "top", order: 0 },
  declared_queries: [{
    from: "records",
    aggregate: [
      { fn: "count", field: "id", as: "n" },
      { fn: "sum", field: "value", as: "total" },
      { fn: "avg", field: "value", as: "average" }],
  }],
  declared_writes: [],
  code: `export default function (clay) {
  const q = { from: "records", aggregate: [{ fn: "count", field: "id", as: "n" }, { fn: "sum", field: "value", as: "total" }, { fn: "avg", field: "value", as: "average" }] };
  clay.db.watch(q, (rows) => {
    const m = rows[0] || {};
    clay.ui.render(h(Grid, {},
      h(MetricCard, { label: "Records", value: m.n }),
      h(MetricCard, { label: "Total", value: m.total, format: "number" }),
      h(MetricCard, { label: "Average", value: m.average, format: "number" })));
  });
}`,
};

const records_table: PanelBlobInput = {
  panel_id: "records_table", title: "Records",
  placement: { region: "main", order: 0 },
  declared_queries: [{ from: "records", orderBy: [{ field: "on", dir: "desc" }] }],
  declared_writes: [],
  code: `export default function (clay) {
  clay.db.watch({ from: "records", orderBy: [{ field: "on", dir: "desc" }] }, (rows) => {
    clay.ui.render(rows.length === 0
      ? h(EmptyState, { label: "No records yet" })
      : h(Table, { sortable: true, rows, columns: [
          { field: "name", label: "Name" },
          { field: "category", label: "Category",
            badge: { field: "category", map: { a: "accent", b: "amber", c: "green" } } },
          { field: "value", label: "Value", format: "currency" },
          { field: "on", label: "On", format: "date" }] }));
  });
}`,
};

const by_category_chart: PanelBlobInput = {
  panel_id: "by_category_chart", title: "By category",
  placement: { region: "main", order: 1 },
  declared_queries: [{
    from: "records", groupBy: ["category"],
    aggregate: [{ fn: "count", field: "category", as: "n" }],
  }],
  declared_writes: [],
  code: `export default function (clay) {
  const q = { from: "records", groupBy: ["category"], aggregate: [{ fn: "count", field: "category", as: "n" }] };
  clay.db.watch(q, (rows) => {
    const data = rows.map((r) => ({ x: r.category, y: r.n }));
    clay.ui.render(data.length === 0
      ? h(EmptyState, { label: "Categories chart appears with your first record" })
      : h(Chart, { kind: "bar", data, xLabel: "Category", yLabel: "Count", height: 200 }));
  });
}`,
};

// ---------- small business (multi-table, one dataset seen many ways) ----------
const JOB_TONES = `{ lead: "gray", scheduled: "accent", in_progress: "amber", done: "green", invoiced: "green" }`;

const sb_dashboard: PanelBlobInput = {
  panel_id: "sb_dashboard", title: "The business",
  placement: { region: "top", order: 0 },
  declared_queries: [{ from: "jobs" }, { from: "invoices" }],
  declared_writes: [],
  code: `export default function (clay) {
  let jobs = [], invoices = [];
  const money = (n) => clay.compute.formatCurrency(n || 0);
  const draw = () => {
    const open = jobs.filter((j) => j.status !== "done" && j.status !== "invoiced").length;
    const paid = invoices.filter((i) => i.status === "paid").reduce((s, i) => s + (i.amount || 0), 0);
    const unpaid = invoices.filter((i) => i.status !== "paid").reduce((s, i) => s + (i.amount || 0), 0);
    clay.ui.render(h(Grid, {},
      h(MetricCard, { label: "Open jobs", value: open }),
      h(MetricCard, { label: "Revenue", value: paid, format: "currency" }),
      h(MetricCard, { label: "Unpaid", value: unpaid, format: "currency" })));
  };
  clay.db.watch({ from: "jobs" }, (r) => { jobs = r; draw(); });
  clay.db.watch({ from: "invoices" }, (r) => { invoices = r; draw(); });
}`,
};

const sb_upcoming: PanelBlobInput = {
  panel_id: "sb_upcoming", title: "Next 2 weeks",
  placement: { region: "top", order: 1 },
  declared_queries: [{ from: "jobs",
    where: [{ field: "scheduled", op: "within_days", value: 14 }],
    orderBy: [{ field: "scheduled", dir: "asc" }] }],
  declared_writes: [],
  code: `export default function (clay) {
  const q = { from: "jobs", where: [{ field: "scheduled", op: "within_days", value: 14 }], orderBy: [{ field: "scheduled", dir: "asc" }] };
  clay.db.watch(q, (rows) => {
    clay.ui.render(rows.length === 0
      ? h(EmptyState, { label: "Nothing scheduled soon" })
      : h(Table, { rows, columns: [
          { field: "title", label: "Upcoming job" },
          { field: "customer", label: "Customer" },
          { field: "scheduled", label: "When", format: "date" }] }));
  });
}`,
};

// The multi-view star: jobs as a KANBAN...
const JOB_STAGES = `["lead", "scheduled", "in_progress", "done", "invoiced"]`;

const sb_jobs_board: PanelBlobInput = {
  panel_id: "sb_jobs_board", title: "Jobs board · drag a job between stages",
  placement: { region: "main", order: 0, w: 4 },
  declared_queries: [{ from: "jobs" }],
  declared_writes: ["jobs"],
  code: `export default function (clay) {
  const cols = ${JOB_STAGES};
  const tones = ${JOB_TONES};
  const move = async (card, toStatus) => {
    try { await clay.db.update("jobs", card.id, { status: toStatus }); clay.ui.toast(card.title + " → " + toStatus.split("_").join(" "), "success"); }
    catch (e) { clay.ui.toast("Could not move: " + e.message, "danger"); }
  };
  clay.db.watch({ from: "jobs" }, (rows) => {
    const groups = cols.map((s) => ({
      key: s, label: s.split("_").join(" "), tone: tones[s],
      cards: rows.filter((r) => r.status === s).map((r) => ({
        id: r.id, title: r.title, subtitle: r.customer,
        badge: r.price ? clay.compute.formatCurrency(r.price) : null })),
    }));
    clay.ui.render(h(Board, { groups, onCardMove: move }));
  });
}`,
};

// ...and the SAME jobs as a TABLE (multi-view over one dataset).
const sb_jobs_table: PanelBlobInput = {
  panel_id: "sb_jobs_table", title: "All jobs",
  placement: { region: "main", order: 1 },
  declared_queries: [{ from: "jobs", orderBy: [{ field: "scheduled", dir: "asc" }] }],
  declared_writes: [],
  code: `export default function (clay) {
  clay.db.watch({ from: "jobs", orderBy: [{ field: "scheduled", dir: "asc" }] }, (rows) => {
    clay.ui.render(rows.length === 0
      ? h(EmptyState, { label: "Add your first job on the right" })
      : h(Table, { sortable: true, rows, columns: [
          { field: "title", label: "Job" },
          { field: "customer", label: "Customer" },
          { field: "status", label: "Status", badge: { field: "status", map: ${JOB_TONES} } },
          { field: "scheduled", label: "Scheduled", format: "date" },
          { field: "price", label: "Price", format: "currency" }] }));
  });
}`,
};

const sb_revenue: PanelBlobInput = {
  panel_id: "sb_revenue", title: "Revenue by month",
  placement: { region: "main", order: 2 },
  declared_queries: [{ from: "invoices",
    where: [{ field: "status", op: "eq", value: "paid" }], select: ["issued", "amount"] }],
  declared_writes: [],
  code: `export default function (clay) {
  const q = { from: "invoices", where: [{ field: "status", op: "eq", value: "paid" }], select: ["issued", "amount"] };
  clay.db.watch(q, (rows) => {
    const byMonth = {};
    for (const r of rows) { if (!r.issued) continue; const m = String(r.issued).slice(0, 7); byMonth[m] = (byMonth[m] || 0) + (r.amount || 0); }
    const data = Object.keys(byMonth).sort().map((m) => ({ x: m, y: byMonth[m] }));
    clay.ui.render(data.length === 0
      ? h(EmptyState, { label: "Revenue appears as invoices are paid" })
      : h(Chart, { kind: "bar", data, xLabel: "Month", yLabel: "Revenue", height: 200 }));
  });
}`,
};

const sb_invoices: PanelBlobInput = {
  panel_id: "sb_invoices", title: "Invoices",
  placement: { region: "main", order: 3 },
  declared_queries: [{ from: "invoices", orderBy: [{ field: "due", dir: "asc" }] }],
  declared_writes: [],
  code: `export default function (clay) {
  clay.db.watch({ from: "invoices", orderBy: [{ field: "due", dir: "asc" }] }, (rows) => {
    clay.ui.render(rows.length === 0
      ? h(EmptyState, { label: "No invoices yet" })
      : h(Table, { sortable: true, rows, columns: [
          { field: "customer", label: "Customer" },
          { field: "amount", label: "Amount", format: "currency" },
          { field: "status", label: "Status", badge: { field: "status", map: { draft: "gray", sent: "amber", paid: "green" } } },
          { field: "due", label: "Due", format: "date" }] }));
  });
}`,
};

const sb_customers: PanelBlobInput = {
  panel_id: "sb_customers", title: "Customers",
  placement: { region: "side", order: 0 },
  declared_queries: [{ from: "customers", orderBy: [{ field: "name", dir: "asc" }] }],
  declared_writes: [],
  code: `export default function (clay) {
  clay.db.watch({ from: "customers", orderBy: [{ field: "name", dir: "asc" }] }, (rows) => {
    clay.ui.render(rows.length === 0
      ? h(EmptyState, { label: "No customers yet" })
      : h(Cards, { items: rows.map((c) => ({
          title: c.name, subtitle: c.email || c.phone,
          fields: [{ label: "Phone", value: c.phone || "—" }] })) }));
  });
}`,
};

const sb_add_job: PanelBlobInput = {
  panel_id: "sb_add_job", title: "New job",
  placement: { region: "side", order: 1 },
  declared_queries: [],
  declared_writes: ["jobs"],
  code: `export default function (clay) {
  clay.ui.render(h(Form, {
    submitLabel: "Add job",
    fields: [
      { name: "title", label: "Job", kind: "text", required: true },
      { name: "customer", label: "Customer", kind: "text" },
      { name: "status", label: "Status", kind: "select", fromSchema: "jobs.status" },
      { name: "scheduled", label: "Scheduled", kind: "date" },
      { name: "price", label: "Price", kind: "number" }],
    onSubmit: async (v) => {
      try { await clay.db.insert("jobs", v); clay.ui.toast("Job added", "success"); }
      catch (e) { clay.ui.toast("Could not add: " + e.message, "danger"); }
    } }));
}`,
};

// ---------- compact builder for the additional templates ----------
type Q = PanelBlobInput["declared_queries"][number];
const panel = (
  panel_id: string, title: string, region: "top" | "main" | "side", order: number,
  declared_queries: Q[], declared_writes: string[], code: string, w?: number,
): PanelBlobInput => ({
  panel_id, title, placement: { region, order, ...(w && w > 1 ? { w } : {}) },
  declared_queries, declared_writes, code,
});

// ---------- Sales CRM ----------
const DEAL_TONES = `{ lead: "gray", qualified: "accent", proposal: "amber", negotiation: "amber", won: "green", lost: "red" }`;
const DEAL_STAGES = `["lead", "qualified", "proposal", "negotiation", "won", "lost"]`;

const crm = [
  panel("crm_metrics", "Pipeline at a glance", "top", 0, [{ from: "deals" }], [],
    `export default function (clay) {
  clay.db.watch({ from: "deals" }, (rows) => {
    const open = rows.filter((d) => d.stage !== "won" && d.stage !== "lost");
    const weighted = open.reduce((s, d) => s + (d.value || 0) * ((d.probability || 0) / 100), 0);
    const won = rows.filter((d) => d.stage === "won");
    const wonVal = won.reduce((s, d) => s + (d.value || 0), 0);
    const closed = rows.filter((d) => d.stage === "won" || d.stage === "lost").length;
    const winRate = closed > 0 ? Math.round((won.length / closed) * 100) : 0;
    clay.ui.render(h(Grid, {},
      h(MetricCard, { label: "Open deals", value: open.length }),
      h(MetricCard, { label: "Weighted pipeline", value: weighted, format: "currency" }),
      h(MetricCard, { label: "Won", value: wonVal, format: "currency" }),
      h(MetricCard, { label: "Win rate %", value: winRate })));
  });
}`),
  panel("crm_today", "Follow-ups", "top", 1,
    [{ from: "tasks", where: [{ field: "status", op: "eq", value: "open" }], orderBy: [{ field: "due", dir: "asc" }] }], [],
    `export default function (clay) {
  const q = { from: "tasks", where: [{ field: "status", op: "eq", value: "open" }], orderBy: [{ field: "due", dir: "asc" }] };
  clay.db.watch(q, (rows) => {
    clay.ui.render(rows.length === 0 ? h(EmptyState, { label: "No open follow-ups — nice" })
      : h(Table, { rows, columns: [
        { field: "title", label: "Task" }, { field: "deal", label: "Deal" },
        { field: "due", label: "Due", format: "date" },
        { field: "priority", label: "Priority", badge: { field: "priority", map: { low: "gray", medium: "accent", high: "red" } } }] }));
  });
}`),
  panel("crm_pipeline", "Pipeline · drag a deal between stages", "main", 0, [{ from: "deals" }], ["deals"],
    `export default function (clay) {
  const stages = ${DEAL_STAGES};
  const tones = ${DEAL_TONES};
  const move = async (card, toStage) => {
    try { await clay.db.update("deals", card.id, { stage: toStage }); clay.ui.toast(card.title + " → " + toStage, "success"); }
    catch (e) { clay.ui.toast("Could not move: " + e.message, "danger"); }
  };
  clay.db.watch({ from: "deals" }, (rows) => {
    const groups = stages.map((s) => ({ key: s, label: s, tone: tones[s],
      cards: rows.filter((r) => r.stage === s).map((r) => ({ id: r.id,
        title: r.title, subtitle: (r.company || r.contact || "") + (r.probability ? " · " + r.probability + "%" : ""),
        badge: r.value ? clay.compute.formatCurrency(r.value) : null })) }));
    clay.ui.render(h(Board, { groups, onCardMove: move }));
  });
}`, 4),
  panel("crm_deals_table", "All deals", "main", 1,
    [{ from: "deals", orderBy: [{ field: "expected_close", dir: "asc" }] }], [],
    `export default function (clay) {
  clay.db.watch({ from: "deals", orderBy: [{ field: "expected_close", dir: "asc" }] }, (rows) => {
    clay.ui.render(rows.length === 0 ? h(EmptyState, { label: "No deals yet" })
      : h(Table, { sortable: true, rows, columns: [
        { field: "title", label: "Deal" }, { field: "company", label: "Company" },
        { field: "stage", label: "Stage", badge: { field: "stage", map: ${DEAL_TONES} } },
        { field: "value", label: "Value", format: "currency" },
        { field: "probability", label: "Prob %" },
        { field: "expected_close", label: "Close", format: "date" }] }));
  });
}`),
  panel("crm_forecast", "Pipeline by stage", "main", 2, [{ from: "deals" }], [],
    `export default function (clay) {
  const order = ${DEAL_STAGES};
  clay.db.watch({ from: "deals" }, (rows) => {
    const byStage = {};
    for (const d of rows) { if (d.stage === "won" || d.stage === "lost") continue; byStage[d.stage] = (byStage[d.stage] || 0) + (d.value || 0); }
    const data = order.filter((s) => byStage[s]).map((s) => ({ x: s, y: byStage[s] }));
    clay.ui.render(data.length === 0 ? h(EmptyState, { label: "Open-deal value by stage appears here" })
      : h(Chart, { kind: "bar", data, xLabel: "Stage", yLabel: "Value", height: 200 }));
  });
}`),
  panel("crm_activities", "Recent activity", "main", 3,
    [{ from: "activities", orderBy: [{ field: "on", dir: "desc" }] }], [],
    `export default function (clay) {
  clay.db.watch({ from: "activities", orderBy: [{ field: "on", dir: "desc" }] }, (rows) => {
    clay.ui.render(rows.length === 0 ? h(EmptyState, { label: "Log calls, emails, and meetings here" })
      : h(Table, { rows, columns: [
        { field: "on", label: "When", format: "date" }, { field: "type", label: "Type" },
        { field: "subject", label: "Subject" }, { field: "contact", label: "Contact" }] }));
  });
}`),
  panel("crm_contacts", "Contacts", "side", 0,
    [{ from: "contacts", orderBy: [{ field: "name", dir: "asc" }] }], [],
    `export default function (clay) {
  clay.db.watch({ from: "contacts", orderBy: [{ field: "name", dir: "asc" }] }, (rows) => {
    clay.ui.render(rows.length === 0 ? h(EmptyState, { label: "No contacts yet" })
      : h(Cards, { items: rows.map((c) => ({ title: c.name, subtitle: c.title ? c.title + " · " + (c.company || "") : c.company,
          fields: [{ label: "Email", value: c.email || "-" }, { label: "Phone", value: c.phone || "-" }] })) }));
  });
}`),
  panel("crm_add_deal", "New deal", "side", 1, [], ["deals"],
    `export default function (clay) {
  clay.ui.render(h(Form, { submitLabel: "Add deal", fields: [
    { name: "title", label: "Deal", kind: "text", required: true },
    { name: "contact", label: "Contact", kind: "text" },
    { name: "company", label: "Company", kind: "text" },
    { name: "stage", label: "Stage", kind: "select", fromSchema: "deals.stage" },
    { name: "value", label: "Value", kind: "number" },
    { name: "source", label: "Source", kind: "select", fromSchema: "deals.source" },
    { name: "expected_close", label: "Expected close", kind: "date" }],
    onSubmit: async (v) => { try { await clay.db.insert("deals", v); clay.ui.toast("Deal added", "success"); }
      catch (e) { clay.ui.toast("Could not add: " + e.message, "danger"); } } }));
}`),
  panel("crm_add_task", "New follow-up", "side", 2, [], ["tasks"],
    `export default function (clay) {
  clay.ui.render(h(Form, { submitLabel: "Add task", fields: [
    { name: "title", label: "Task", kind: "text", required: true },
    { name: "deal", label: "Deal", kind: "text" },
    { name: "due", label: "Due", kind: "date" },
    { name: "priority", label: "Priority", kind: "select", fromSchema: "tasks.priority" }],
    onSubmit: async (v) => { try { await clay.db.insert("tasks", { status: "open", ...v }); clay.ui.toast("Task added", "success"); }
      catch (e) { clay.ui.toast("Could not add: " + e.message, "danger"); } } }));
}`),
];

// ---------- Bookkeeping / Financials ----------
const financials = [
  panel("fin_summary", "This month", "top", 0, [{ from: "transactions" }], [],
    `export default function (clay) {
  clay.db.watch({ from: "transactions" }, (rows) => {
    const income = rows.filter((t) => t.kind === "income").reduce((s, t) => s + (t.amount || 0), 0);
    const expense = rows.filter((t) => t.kind === "expense").reduce((s, t) => s + (t.amount || 0), 0);
    clay.ui.render(h(Grid, {},
      h(MetricCard, { label: "Income", value: income, format: "currency" }),
      h(MetricCard, { label: "Expenses", value: expense, format: "currency" }),
      h(MetricCard, { label: "Net", value: income - expense, format: "currency" })));
  });
}`),
  panel("fin_spending", "Spending by category", "main", 0,
    [{ from: "transactions", where: [{ field: "kind", op: "eq", value: "expense" }], select: ["category", "amount"] }], [],
    `export default function (clay) {
  const q = { from: "transactions", where: [{ field: "kind", op: "eq", value: "expense" }], select: ["category", "amount"] };
  clay.db.watch(q, (rows) => {
    const byCat = {};
    for (const t of rows) { const c = t.category || "Other"; byCat[c] = (byCat[c] || 0) + (t.amount || 0); }
    const data = Object.keys(byCat).sort().map((c) => ({ x: c, y: byCat[c] }));
    clay.ui.render(data.length === 0 ? h(EmptyState, { label: "Spending by category appears here" })
      : h(Chart, { kind: "bar", data, xLabel: "Category", yLabel: "Spent", height: 200 }));
  });
}`),
  panel("fin_transactions", "Transactions", "main", 1,
    [{ from: "transactions", orderBy: [{ field: "on", dir: "desc" }] }], [],
    `export default function (clay) {
  clay.db.watch({ from: "transactions", orderBy: [{ field: "on", dir: "desc" }] }, (rows) => {
    clay.ui.render(rows.length === 0 ? h(EmptyState, { label: "No transactions yet" })
      : h(Table, { sortable: true, rows, columns: [
        { field: "description", label: "Description" },
        { field: "kind", label: "Kind", badge: { field: "kind", map: { income: "green", expense: "red" } } },
        { field: "amount", label: "Amount", format: "currency" },
        { field: "on", label: "Date", format: "date" }] }));
  });
}`),
  panel("fin_invoices", "Invoices by status · drag to update", "main", 2,
    [{ from: "invoices" }], ["invoices"],
    `export default function (clay) {
  const cols = ["draft", "sent", "paid", "overdue"];
  const tones = { draft: "gray", sent: "amber", paid: "green", overdue: "red" };
  const move = async (card, toStatus) => {
    try { await clay.db.update("invoices", card.id, { status: toStatus }); clay.ui.toast(card.title + " → " + toStatus, "success"); }
    catch (e) { clay.ui.toast("Could not move: " + e.message, "danger"); }
  };
  clay.db.watch({ from: "invoices" }, (rows) => {
    const groups = cols.map((s) => ({ key: s, label: s, tone: tones[s],
      cards: rows.filter((r) => r.status === s).map((r) => ({ id: r.id, title: r.customer,
        subtitle: r.due ? "due " + r.due : "", badge: r.amount ? clay.compute.formatCurrency(r.amount) : null })) }));
    clay.ui.render(h(Board, { groups, onCardMove: move }));
  });
}`, 4),
  panel("fin_bills", "Unpaid bills", "side", 0,
    [{ from: "bills", where: [{ field: "status", op: "eq", value: "unpaid" }], orderBy: [{ field: "due", dir: "asc" }] }], [],
    `export default function (clay) {
  const q = { from: "bills", where: [{ field: "status", op: "eq", value: "unpaid" }], orderBy: [{ field: "due", dir: "asc" }] };
  clay.db.watch(q, (rows) => {
    clay.ui.render(rows.length === 0 ? h(EmptyState, { label: "No unpaid bills" })
      : h(Cards, { items: rows.map((b) => ({ title: b.vendor, subtitle: clay.compute.formatCurrency(b.amount || 0),
          fields: [{ label: "Due", value: b.due || "-" }] })) }));
  });
}`),
  panel("fin_add_txn", "Record transaction", "side", 1, [], ["transactions"],
    `export default function (clay) {
  clay.ui.render(h(Form, { submitLabel: "Record", fields: [
    { name: "description", label: "Description", kind: "text", required: true },
    { name: "account", label: "Account", kind: "text" },
    { name: "kind", label: "Kind", kind: "select", fromSchema: "transactions.kind" },
    { name: "amount", label: "Amount", kind: "number" },
    { name: "category", label: "Category", kind: "text" },
    { name: "on", label: "Date", kind: "date" }],
    onSubmit: async (v) => { try { await clay.db.insert("transactions", v); clay.ui.toast("Recorded", "success"); }
      catch (e) { clay.ui.toast("Could not add: " + e.message, "danger"); } } }));
}`),
];

// ---------- Staff & Scheduling ----------
const staff = [
  panel("staff_today", "Next 7 days", "top", 0,
    [{ from: "shifts", where: [{ field: "date", op: "within_days", value: 7 }], orderBy: [{ field: "date", dir: "asc" }] }], [],
    `export default function (clay) {
  const q = { from: "shifts", where: [{ field: "date", op: "within_days", value: 7 }], orderBy: [{ field: "date", dir: "asc" }] };
  clay.db.watch(q, (rows) => {
    clay.ui.render(rows.length === 0 ? h(EmptyState, { label: "No shifts in the next week" })
      : h(Table, { rows, columns: [
        { field: "employee", label: "Who" }, { field: "date", label: "Date", format: "date" },
        { field: "start_time", label: "Start" }, { field: "end_time", label: "End" }] }));
  });
}`),
  panel("staff_board", "Shift board · drag a shift between columns", "main", 0, [{ from: "shifts" }], ["shifts"],
    `export default function (clay) {
  const cols = ["scheduled", "confirmed", "completed"];
  const tones = { scheduled: "gray", confirmed: "accent", completed: "green" };
  const move = async (card, toStatus) => {
    try { await clay.db.update("shifts", card.id, { status: toStatus }); clay.ui.toast(card.title + " → " + toStatus, "success"); }
    catch (e) { clay.ui.toast("Could not move: " + e.message, "danger"); }
  };
  clay.db.watch({ from: "shifts" }, (rows) => {
    const groups = cols.map((s) => ({ key: s, label: s, tone: tones[s],
      cards: rows.filter((r) => r.status === s).map((r) => ({ id: r.id, title: r.employee,
        subtitle: r.date + " " + (r.start_time || ""), badge: r.role })) }));
    clay.ui.render(h(Board, { groups, onCardMove: move }));
  });
}`, 4),
  panel("shift_calendar", "Calendar", "main", 1,
    [{ from: "shifts", orderBy: [{ field: "date", dir: "asc" }] }], [],
    `export default function (clay) {
  const tones = { scheduled: "gray", confirmed: "accent", completed: "green" };
  clay.db.watch({ from: "shifts", orderBy: [{ field: "date", dir: "asc" }] }, (rows) => {
    clay.ui.render(rows.length === 0
      ? h(EmptyState, { label: "No shifts yet - add one on the right" })
      : h(Calendar, { items: rows.map((r) => ({ date: r.date,
          label: (r.employee || "") + (r.start_time ? " " + r.start_time : ""),
          tone: tones[r.status] || "gray" })) }));
  });
}`),
  panel("staff_shifts", "All shifts", "main", 2,
    [{ from: "shifts", orderBy: [{ field: "date", dir: "asc" }] }], [],
    `export default function (clay) {
  clay.db.watch({ from: "shifts", orderBy: [{ field: "date", dir: "asc" }] }, (rows) => {
    clay.ui.render(rows.length === 0 ? h(EmptyState, { label: "Add a shift on the right" })
      : h(Table, { sortable: true, rows, columns: [
        { field: "employee", label: "Employee" }, { field: "date", label: "Date", format: "date" },
        { field: "role", label: "Role" },
        { field: "status", label: "Status", badge: { field: "status", map: { scheduled: "gray", confirmed: "accent", completed: "green" } } }] }));
  });
}`),
  panel("staff_timeoff", "Time off", "main", 3,
    [{ from: "time_off", orderBy: [{ field: "start_date", dir: "asc" }] }], [],
    `export default function (clay) {
  clay.db.watch({ from: "time_off", orderBy: [{ field: "start_date", dir: "asc" }] }, (rows) => {
    clay.ui.render(rows.length === 0 ? h(EmptyState, { label: "No time-off requests" })
      : h(Table, { rows, columns: [
        { field: "employee", label: "Employee" }, { field: "kind", label: "Type" },
        { field: "start_date", label: "From", format: "date" },
        { field: "status", label: "Status", badge: { field: "status", map: { pending: "amber", approved: "green", denied: "red" } } }] }));
  });
}`),
  panel("staff_roster", "Team", "side", 0,
    [{ from: "employees", orderBy: [{ field: "name", dir: "asc" }] }], [],
    `export default function (clay) {
  clay.db.watch({ from: "employees", orderBy: [{ field: "name", dir: "asc" }] }, (rows) => {
    clay.ui.render(rows.length === 0 ? h(EmptyState, { label: "No employees yet" })
      : h(Cards, { items: rows.map((e) => ({ title: e.name, subtitle: e.role,
          badge: e.status, badgeTone: e.status === "active" ? "green" : "gray",
          fields: [{ label: "Phone", value: e.phone || "-" }] })) }));
  });
}`),
  panel("staff_add_shift", "Add shift", "side", 1, [], ["shifts"],
    `export default function (clay) {
  clay.ui.render(h(Form, { submitLabel: "Add shift", fields: [
    { name: "employee", label: "Employee", kind: "text" },
    { name: "date", label: "Date", kind: "date", required: true },
    { name: "start_time", label: "Start", kind: "text" },
    { name: "end_time", label: "End", kind: "text" },
    { name: "role", label: "Role", kind: "text" },
    { name: "status", label: "Status", kind: "select", fromSchema: "shifts.status" }],
    onSubmit: async (v) => { try { await clay.db.insert("shifts", v); clay.ui.toast("Shift added", "success"); }
      catch (e) { clay.ui.toast("Could not add: " + e.message, "danger"); } } }));
}`),
];

// ---------- habits ----------
const habits_overview = panel(
  "habits_overview", "This week", "top", 0,
  [{ from: "habits" }], [],
  `export default function (clay) {
  clay.db.watch({ from: "habits" }, (rows) => {
    const total = rows.length;
    const active = rows.filter((r) => (r.streak || 0) > 0).length;
    const avg = total ? Math.round(rows.reduce((s, r) => s + (r.streak || 0), 0) / total) : 0;
    clay.ui.render(h(Grid, {},
      h(MetricCard, { label: "Habits", value: total }),
      h(MetricCard, { label: "On a streak", value: active }),
      h(MetricCard, { label: "Avg streak (days)", value: avg })));
  });
}`);

const habits_board = panel(
  "habits_board", "By area · drag to recategorise", "main", 0,
  [{ from: "habits" }], ["habits"],
  `export default function (clay) {
  const cats = ["health", "mind", "work", "social"];
  clay.db.watch({ from: "habits" }, (rows) => {
    const groups = cats.map((c) => ({ key: c, label: c, tone: "accent",
      cards: rows.filter((r) => r.category === c).map((r) => ({
        id: r.id, title: r.name, subtitle: (r.streak || 0) + " day streak" })) }));
    clay.ui.render(h(Board, { groups, onCardMove: async (card, toKey) => {
      await clay.db.update("habits", card.id, { category: toKey });
    } }));
  });
}`, 4);

const habits_table = panel(
  "habits_table", "All habits", "main", 1,
  [{ from: "habits", orderBy: [{ field: "streak", dir: "desc" }] }], [],
  `export default function (clay) {
  clay.db.watch({ from: "habits", orderBy: [{ field: "streak", dir: "desc" }] }, (rows) => {
    clay.ui.render(rows.length === 0
      ? h(EmptyState, { label: "Add a habit to start a streak" })
      : h(Table, { sortable: true, rows, columns: [
          { field: "name", label: "Habit" },
          { field: "category", label: "Area",
            badge: { field: "category", map: { health: "green", mind: "accent", work: "amber", social: "red" } } },
          { field: "streak", label: "Streak", format: "number" },
          { field: "best", label: "Best", format: "number" },
          { field: "last_done", label: "Last done", format: "date" }] }));
  });
}`, 4);

const add_habit_form = panel(
  "add_habit_form", "Add habit", "side", 0,
  [], ["habits"],
  `export default function (clay) {
  clay.ui.render(h(Form, {
    submitLabel: "Add habit",
    fields: [
      { name: "name", label: "Habit", kind: "text", required: true },
      { name: "category", label: "Area", kind: "select", fromSchema: "habits.category" },
      { name: "streak", label: "Current streak", kind: "number" },
      { name: "best", label: "Best streak", kind: "number" },
      { name: "last_done", label: "Last done", kind: "date" }],
    onSubmit: async (v) => {
      try {
        await clay.db.insert("habits", v);
        clay.ui.toast("Habit added", "success");
      } catch (e) {
        clay.ui.toast("Could not add: " + e.message, "danger");
      }
    } }));
}`);

// ---------- inventory ----------
const inv_overview = panel(
  "inv_overview", "Stock at a glance", "top", 0,
  [{ from: "products" }], [],
  `export default function (clay) {
  clay.db.watch({ from: "products" }, (rows) => {
    const total = rows.length;
    const low = rows.filter((r) => (r.stock || 0) <= (r.reorder_at || 0)).length;
    const units = rows.reduce((s, r) => s + (r.stock || 0), 0);
    clay.ui.render(h(Grid, {},
      h(MetricCard, { label: "Products", value: total }),
      h(MetricCard, { label: "Need reorder", value: low }),
      h(MetricCard, { label: "Units in stock", value: units })));
  });
}`);

const inv_low = panel(
  "inv_low", "Reorder soon", "main", 0,
  [{ from: "products", orderBy: [{ field: "stock", dir: "asc" }] }], [],
  `export default function (clay) {
  clay.db.watch({ from: "products", orderBy: [{ field: "stock", dir: "asc" }] }, (rows) => {
    const low = rows.filter((r) => (r.stock || 0) <= (r.reorder_at || 0));
    clay.ui.render(low.length === 0
      ? h(EmptyState, { label: "All stocked up" })
      : h(Table, { sortable: true, rows: low, columns: [
          { field: "name", label: "Product" },
          { field: "sku", label: "SKU" },
          { field: "stock", label: "In stock", format: "number" },
          { field: "reorder_at", label: "Reorder at", format: "number" }] }));
  });
}`, 4);

const inv_table = panel(
  "inv_table", "All products", "main", 1,
  [{ from: "products", orderBy: [{ field: "name", dir: "asc" }] }], [],
  `export default function (clay) {
  clay.db.watch({ from: "products", orderBy: [{ field: "name", dir: "asc" }] }, (rows) => {
    clay.ui.render(rows.length === 0
      ? h(EmptyState, { label: "Add a product on the right" })
      : h(Table, { sortable: true, rows, columns: [
          { field: "name", label: "Product" },
          { field: "sku", label: "SKU" },
          { field: "category", label: "Category",
            badge: { field: "category", map: { retail: "accent", food: "green", supplies: "amber", other: "gray" } } },
          { field: "price", label: "Price", format: "currency" },
          { field: "stock", label: "Stock", format: "number" }] }));
  });
}`, 4);

const add_product = panel(
  "add_product", "Add product", "side", 0,
  [], ["products"],
  `export default function (clay) {
  clay.ui.render(h(Form, {
    submitLabel: "Add product",
    fields: [
      { name: "name", label: "Product", kind: "text", required: true },
      { name: "sku", label: "SKU", kind: "text" },
      { name: "category", label: "Category", kind: "select", fromSchema: "products.category" },
      { name: "price", label: "Price", kind: "number" },
      { name: "stock", label: "In stock", kind: "number" },
      { name: "reorder_at", label: "Reorder at", kind: "number" }],
    onSubmit: async (v) => {
      try {
        await clay.db.insert("products", v);
        clay.ui.toast("Product added", "success");
      } catch (e) {
        clay.ui.toast("Could not add: " + e.message, "danger");
      }
    } }));
}`);

// ---------- audit additions (ADR-026): process/insight/entry gaps ----------
// tracker: items have todo -> doing -> done, which is a PROCESS — show it
const items_flow: PanelBlobInput = {
  panel_id: "items_flow", title: "Progress",
  placement: { region: "main", order: 0 },
  declared_queries: [{ from: "items", orderBy: [{ field: "due", dir: "asc" }] }],
  declared_writes: ["items"],
  code: `export default function (clay) {
  const stages = [
    { key: "todo", label: "To do", tone: "gray" },
    { key: "doing", label: "Doing", tone: "amber" },
    { key: "done", label: "Done", tone: "green" }];
  clay.db.watch({ from: "items", orderBy: [{ field: "due", dir: "asc" }] }, (rows) => {
    const items = rows.map((r) => ({ id: r.id, title: r.name,
      subtitle: r.owner || "", stage: r.status, since: r.updated_at, badge: r.due || "", badgeTone: "gray" }));
    clay.ui.render(h(Flow, { stages, items,
      onAdvance: async (item, toKey) => {
        try { await clay.db.update("items", item.id, { status: toKey }); }
        catch (e) { clay.ui.toast("Could not move: " + e.message, "danger"); }
      } }));
  });
}`,
};

// dashboard: a dashboard you cannot feed is read-only — add the entry form
const add_record_form: PanelBlobInput = {
  panel_id: "add_record_form", title: "Add record",
  placement: { region: "side", order: 0 },
  declared_queries: [],
  declared_writes: ["records"],
  code: `export default function (clay) {
  clay.ui.render(h(Form, { submitLabel: "Add record", fields: [
    { name: "name", label: "Name", kind: "text", required: true },
    { name: "category", label: "Category", kind: "select", fromSchema: "records.category" },
    { name: "value", label: "Value", kind: "number" },
    { name: "on", label: "Date", kind: "date" }],
    onSubmit: async (v) => {
      try { await clay.db.insert("records", v); clay.ui.toast("Added", "success"); }
      catch (e) { clay.ui.toast("Could not add: " + e.message, "danger"); }
    } }));
}`,
};

// habits: the insight is the streaks themselves — chart them
const streak_chart: PanelBlobInput = {
  panel_id: "streak_chart", title: "Streaks",
  placement: { region: "main", order: 2 },
  declared_queries: [{ from: "habits", orderBy: [{ field: "streak", dir: "desc" }] }],
  declared_writes: [],
  code: `export default function (clay) {
  clay.db.watch({ from: "habits", orderBy: [{ field: "streak", dir: "desc" }] }, (rows) => {
    clay.ui.render(rows.length === 0
      ? h(EmptyState, { label: "Streaks appear once you add habits" })
      : h(Chart, { kind: "bar", height: 190,
          data: rows.map((r) => ({ x: r.name, y: r.streak || 0 })) }));
  });
}`,
};

// inventory: stock health at a glance — stock vs reorder point per product
const inv_stock_chart: PanelBlobInput = {
  panel_id: "inv_stock_chart", title: "Stock vs reorder point",
  placement: { region: "main", order: 2 },
  declared_queries: [{ from: "products", orderBy: [{ field: "stock", dir: "asc" }] }],
  declared_writes: [],
  code: `export default function (clay) {
  clay.db.watch({ from: "products", orderBy: [{ field: "stock", dir: "asc" }] }, (rows) => {
    clay.ui.render(rows.length === 0
      ? h(EmptyState, { label: "Add products to see stock health" })
      : h(Chart, { kind: "bar", height: 200, data: [
          { label: "In stock", data: rows.map((r) => ({ x: r.name, y: r.stock || 0 })) },
          { label: "Reorder at", data: rows.map((r) => ({ x: r.name, y: r.reorder_at || 0 })) }] }));
  });
}`,
};

// ---------- jobs (Job Applications — workflow-native, ADR-026) ----------
const jobs_overview: PanelBlobInput = {
  panel_id: "jobs_overview", title: "Search at a glance",
  placement: { region: "top", order: 0 },
  declared_queries: [{
    from: "applications", groupBy: ["stage"],
    aggregate: [{ fn: "count", field: "stage", as: "n" }],
  }],
  declared_writes: [],
  code: `export default function (clay) {
  const q = { from: "applications", groupBy: ["stage"], aggregate: [{ fn: "count", field: "stage", as: "n" }] };
  clay.db.watch(q, (rows) => {
    const n = (s) => { const r = rows.find((x) => x.stage === s); return r ? r.n : 0; };
    const active = n("saved") + n("applied") + n("interview") + n("offer");
    clay.ui.render(h(Grid, {},
      h(MetricCard, { label: "Active applications", value: active }),
      h(MetricCard, { label: "Interviewing", value: n("interview") }),
      h(MetricCard, { label: "Offers", value: n("offer") }),
      h(MetricCard, { label: "Closed", value: n("closed") })));
  });
}`,
};

const jobs_flow: PanelBlobInput = {
  panel_id: "jobs_flow", title: "Application pipeline",
  placement: { region: "main", order: 0 },
  declared_queries: [{ from: "applications", orderBy: [{ field: "applied_on", dir: "asc" }] }],
  declared_writes: ["applications", "app_activity"],
  code: `export default function (clay) {
  const stages = [
    { key: "saved", label: "Saved", tone: "gray" },
    { key: "applied", label: "Applied", tone: "accent" },
    { key: "interview", label: "Interview", tone: "amber" },
    { key: "offer", label: "Offer", tone: "green" },
    { key: "closed", label: "Closed", tone: "gray" }];
  const label = (k) => { const s = stages.find((x) => x.key === k); return s ? s.label : k; };
  clay.db.watch({ from: "applications", orderBy: [{ field: "applied_on", dir: "asc" }] }, (rows) => {
    const items = rows.map((r) => ({ id: r.id, title: r.company + " \\u00B7 " + (r.role || ""),
      subtitle: r.next_step || "", stage: r.stage, since: r.updated_at,
      badge: r.salary ? clay.compute.formatCurrency(r.salary) : "", badgeTone: "gray" }));
    clay.ui.render(h(Flow, { stages, items,
      onAdvance: async (item, toKey) => {
        try {
          await clay.db.update("applications", item.id, { stage: toKey });
          await clay.db.insert("app_activity", { application: item.title,
            from_stage: item.stage, to_stage: toKey,
            moved_on: clay.compute.now().slice(0, 10) });
          clay.ui.toast(item.title + " \\u2192 " + label(toKey), "success");
        } catch (e) { clay.ui.toast("Could not move: " + e.message, "danger"); }
      } }));
  });
}`,
};

const jobs_table: PanelBlobInput = {
  panel_id: "jobs_table", title: "All applications",
  placement: { region: "main", order: 1 },
  declared_queries: [{ from: "applications", orderBy: [{ field: "applied_on", dir: "desc" }] }],
  declared_writes: [],
  code: `export default function (clay) {
  clay.db.watch({ from: "applications", orderBy: [{ field: "applied_on", dir: "desc" }] }, (rows) => {
    clay.ui.render(rows.length === 0
      ? h(EmptyState, { label: "No applications yet - add one on the right" })
      : h(Table, { sortable: true, rows, columns: [
          { field: "company", label: "Company" },
          { field: "role", label: "Role" },
          { field: "stage", label: "Stage",
            badge: { field: "stage", map: { saved: "gray", applied: "accent", interview: "amber", offer: "green", closed: "gray" } } },
          { field: "salary", label: "Salary", format: "currency" },
          { field: "location", label: "Location" },
          { field: "applied_on", label: "Applied", format: "date" }] }));
  });
}`,
};

const jobs_activity: PanelBlobInput = {
  panel_id: "jobs_activity", title: "Activity",
  placement: { region: "main", order: 2 },
  declared_queries: [{
    from: "app_activity", orderBy: [{ field: "created_at", dir: "desc" }], limit: 12,
  }],
  declared_writes: [],
  code: `export default function (clay) {
  const q = { from: "app_activity", orderBy: [{ field: "created_at", dir: "desc" }], limit: 12 };
  clay.db.watch(q, (rows) => {
    clay.ui.render(rows.length === 0
      ? h(EmptyState, { label: "Moves land here as you advance applications" })
      : h(Stack, {}, rows.map((r) =>
          h(Box, { direction: "row", gap: "sm", align: "center" },
            h(Text, { value: r.application, weight: "bold", size: "sm" }),
            h(Badge, { label: r.from_stage + " \\u2192 " + r.to_stage, tone: "accent" }),
            h(Text, { value: r.moved_on || "", size: "xs", muted: true })))));
  });
}`,
};

const add_application: PanelBlobInput = {
  panel_id: "add_application", title: "Add application",
  placement: { region: "side", order: 0 },
  declared_queries: [],
  declared_writes: ["applications"],
  code: `export default function (clay) {
  clay.ui.render(h(Form, { submitLabel: "Add application", fields: [
    { name: "company", label: "Company", kind: "text", required: true },
    { name: "role", label: "Role", kind: "text" },
    { name: "salary", label: "Salary (USD)", kind: "number" },
    { name: "location", label: "Location", kind: "text" },
    { name: "next_step", label: "Next step", kind: "text" }],
    onSubmit: async (v) => {
      try {
        await clay.db.insert("applications", { ...v, stage: "saved" });
        clay.ui.toast("Saved - it enters the pipeline at Saved", "success");
      } catch (e) { clay.ui.toast("Could not add: " + e.message, "danger"); }
    } }));
}`,
};

// ---------- content (Content Calendar — pipeline + timeline, ADR-026) ----------
const content_overview: PanelBlobInput = {
  panel_id: "content_overview", title: "Pipeline at a glance",
  placement: { region: "top", order: 0 },
  declared_queries: [{
    from: "posts", groupBy: ["stage"],
    aggregate: [{ fn: "count", field: "stage", as: "n" }],
  }],
  declared_writes: [],
  code: `export default function (clay) {
  const q = { from: "posts", groupBy: ["stage"], aggregate: [{ fn: "count", field: "stage", as: "n" }] };
  clay.db.watch(q, (rows) => {
    const n = (s) => { const r = rows.find((x) => x.stage === s); return r ? r.n : 0; };
    clay.ui.render(h(Grid, {},
      h(MetricCard, { label: "Ideas", value: n("idea") }),
      h(MetricCard, { label: "In progress", value: n("draft") + n("review") }),
      h(MetricCard, { label: "Scheduled", value: n("scheduled") }),
      h(MetricCard, { label: "Published", value: n("published") })));
  });
}`,
};

const content_flow: PanelBlobInput = {
  panel_id: "content_flow", title: "Content pipeline",
  placement: { region: "main", order: 0 },
  declared_queries: [{ from: "posts", orderBy: [{ field: "publish_on", dir: "asc" }] }],
  declared_writes: ["posts"],
  code: `export default function (clay) {
  const stages = [
    { key: "idea", label: "Idea", tone: "gray" },
    { key: "draft", label: "Draft", tone: "accent" },
    { key: "review", label: "Review", tone: "amber" },
    { key: "scheduled", label: "Scheduled", tone: "green" },
    { key: "published", label: "Published", tone: "accent" }];
  clay.db.watch({ from: "posts", orderBy: [{ field: "publish_on", dir: "asc" }] }, (rows) => {
    const items = rows.map((r) => ({ id: r.id, title: r.title,
      subtitle: (r.owner || "") + (r.notes ? " \\u00B7 " + r.notes : ""),
      stage: r.stage, since: r.updated_at, badge: r.channel || "", badgeTone: "accent" }));
    clay.ui.render(h(Flow, { stages, items,
      onAdvance: async (item, toKey) => {
        try { await clay.db.update("posts", item.id, { stage: toKey }); }
        catch (e) { clay.ui.toast("Could not move: " + e.message, "danger"); }
      } }));
  });
}`,
};

const content_timeline: PanelBlobInput = {
  panel_id: "content_timeline", title: "Publish schedule",
  placement: { region: "main", order: 1 },
  declared_queries: [{ from: "posts", orderBy: [{ field: "publish_on", dir: "asc" }] }],
  declared_writes: [],
  code: `export default function (clay) {
  const tones = { published: "green", scheduled: "accent", review: "amber", draft: "gray", idea: "gray" };
  clay.db.watch({ from: "posts", orderBy: [{ field: "publish_on", dir: "asc" }] }, (rows) => {
    const dated = rows.filter((r) => r.publish_on);
    clay.ui.render(dated.length === 0
      ? h(EmptyState, { label: "Give posts a publish date to see the schedule" })
      : h(Timeline, { rows: dated.map((r) => ({
          label: r.title, at: r.publish_on, tone: tones[r.stage] || "gray",
          caption: r.channel || "" })) }));
  });
}`,
};

const content_table: PanelBlobInput = {
  panel_id: "content_table", title: "All posts",
  placement: { region: "main", order: 2 },
  declared_queries: [{ from: "posts", orderBy: [{ field: "publish_on", dir: "asc" }] }],
  declared_writes: [],
  code: `export default function (clay) {
  clay.db.watch({ from: "posts", orderBy: [{ field: "publish_on", dir: "asc" }] }, (rows) => {
    clay.ui.render(rows.length === 0
      ? h(EmptyState, { label: "No posts yet - capture an idea on the right" })
      : h(Table, { sortable: true, rows, columns: [
          { field: "title", label: "Title" },
          { field: "channel", label: "Channel",
            badge: { field: "channel", map: { blog: "accent", youtube: "red", newsletter: "amber", social: "green" } } },
          { field: "stage", label: "Stage",
            badge: { field: "stage", map: { idea: "gray", draft: "accent", review: "amber", scheduled: "green", published: "green" } } },
          { field: "publish_on", label: "Publish", format: "date" },
          { field: "owner", label: "Owner" }] }));
  });
}`,
};

const add_post: PanelBlobInput = {
  panel_id: "add_post", title: "Capture an idea",
  placement: { region: "side", order: 0 },
  declared_queries: [],
  declared_writes: ["posts"],
  code: `export default function (clay) {
  clay.ui.render(h(Form, { submitLabel: "Add to pipeline", fields: [
    { name: "title", label: "Title", kind: "text", required: true },
    { name: "channel", label: "Channel", kind: "select", fromSchema: "posts.channel" },
    { name: "publish_on", label: "Target publish date", kind: "date" },
    { name: "owner", label: "Owner", kind: "text" }],
    onSubmit: async (v) => {
      try {
        await clay.db.insert("posts", { ...v, stage: "idea" });
        clay.ui.toast("Captured - it starts as an Idea", "success");
      } catch (e) { clay.ui.toast("Could not add: " + e.message, "danger"); }
    } }));
}`,
};

// ---------- approvals (workflow template, ADR-024) ----------
const approvals_overview: PanelBlobInput = {
  panel_id: "approvals_overview", title: "At a glance",
  placement: { region: "top", order: 0 },
  declared_queries: [
    { from: "requests", groupBy: ["stage"],
      aggregate: [{ fn: "count", field: "stage", as: "n" }] },
    { from: "requests",
      aggregate: [{ fn: "sum", field: "amount", as: "total" }] },
  ],
  declared_writes: [],
  code: `export default function (clay) {
  const byStage = { from: "requests", groupBy: ["stage"], aggregate: [{ fn: "count", field: "stage", as: "n" }] };
  const totals = { from: "requests", aggregate: [{ fn: "sum", field: "amount", as: "total" }] };
  let stages = [], total = 0;
  const draw = () => {
    const n = (s) => { const r = stages.find((x) => x.stage === s); return r ? r.n : 0; };
    clay.ui.render(h(Grid, {},
      h(MetricCard, { label: "Awaiting review", value: n("submitted") + n("in_review") }),
      h(MetricCard, { label: "Approved", value: n("approved") }),
      h(MetricCard, { label: "Paid", value: n("paid") }),
      h(MetricCard, { label: "Total requested", value: total, format: "currency" })));
  };
  clay.db.watch(byStage, (rows) => { stages = rows; draw(); });
  clay.db.watch(totals, (rows) => { total = (rows[0] && rows[0].total) || 0; draw(); });
}`,
};

const request_flow: PanelBlobInput = {
  panel_id: "request_flow", title: "Request workflow",
  placement: { region: "main", order: 0 },
  declared_queries: [
    { from: "requests", orderBy: [{ field: "submitted_on", dir: "asc" }] },
  ],
  declared_writes: ["requests", "request_activity"],
  code: `export default function (clay) {
  const stages = [
    { key: "submitted", label: "Submitted", tone: "gray" },
    { key: "in_review", label: "In review", tone: "amber" },
    { key: "approved", label: "Approved", tone: "green" },
    { key: "paid", label: "Paid", tone: "accent" }];
  const label = (k) => { const s = stages.find((x) => x.key === k); return s ? s.label : k; };
  const q = { from: "requests", orderBy: [{ field: "submitted_on", dir: "asc" }] };
  clay.db.watch(q, (rows) => {
    const items = rows.map((r) => ({ id: r.id, title: r.title,
      subtitle: r.requester, stage: r.stage, since: r.updated_at,
      badge: clay.compute.formatCurrency(r.amount || 0), badgeTone: "gray" }));
    clay.ui.render(h(Flow, { stages, items,
      onAdvance: async (item, toKey) => {
        try {
          await clay.db.update("requests", item.id, { stage: toKey });
          await clay.db.insert("request_activity", { request: item.title,
            from_stage: item.stage, to_stage: toKey,
            moved_on: clay.compute.now().slice(0, 10) });
          clay.ui.toast("\\u201C" + item.title + "\\u201D moved to " + label(toKey), "success");
        } catch (e) { clay.ui.toast("Could not move the request", "danger"); }
      } }));
  });
}`,
};

const activity_log: PanelBlobInput = {
  panel_id: "activity_log", title: "Activity",
  placement: { region: "main", order: 2 },
  declared_queries: [
    { from: "request_activity",
      orderBy: [{ field: "created_at", dir: "desc" }], limit: 12 },
  ],
  declared_writes: [],
  code: `export default function (clay) {
  const q = { from: "request_activity",
    orderBy: [{ field: "created_at", dir: "desc" }], limit: 12 };
  clay.db.watch(q, (rows) => {
    clay.ui.render(rows.length === 0
      ? h(EmptyState, { label: "No moves yet - advance a request and it lands here" })
      : h(Stack, {}, rows.map((r) =>
          h(Box, { direction: "row", gap: "sm", align: "center" },
            h(Text, { value: r.request, weight: "bold", size: "sm" }),
            h(Badge, { label: r.from_stage + " \\u2192 " + r.to_stage, tone: "accent" }),
            h(Text, { value: r.moved_on || "", size: "xs", muted: true })))));
  });
}`,
};

const requests_table: PanelBlobInput = {
  panel_id: "requests_table", title: "All requests",
  placement: { region: "main", order: 1 },
  declared_queries: [
    { from: "requests", orderBy: [{ field: "submitted_on", dir: "desc" }] },
  ],
  declared_writes: [],
  code: `export default function (clay) {
  const q = { from: "requests", orderBy: [{ field: "submitted_on", dir: "desc" }] };
  clay.db.watch(q, (rows) => {
    clay.ui.render(rows.length === 0
      ? h(EmptyState, { label: "No requests yet - submit one on the right" })
      : h(Table, { sortable: true, rows, columns: [
          { field: "title", label: "Request" },
          { field: "requester", label: "Requester" },
          { field: "category", label: "Category",
            badge: { field: "category", map: { equipment: "accent", travel: "amber", software: "green", other: "gray" } } },
          { field: "amount", label: "Amount", format: "currency" },
          { field: "stage", label: "Stage",
            badge: { field: "stage", map: { submitted: "gray", in_review: "amber", approved: "green", paid: "accent" } } },
          { field: "submitted_on", label: "Submitted", format: "date" }] }));
  });
}`,
};

const new_request_form: PanelBlobInput = {
  panel_id: "new_request_form", title: "New request",
  placement: { region: "side", order: 0 },
  declared_queries: [],
  declared_writes: ["requests"],
  code: `export default function (clay) {
  clay.ui.render(h(Form, {
    submitLabel: "Submit request",
    fields: [
      { name: "title", label: "What do you need?", kind: "text", required: true },
      { name: "requester", label: "Requested by", kind: "text" },
      { name: "category", label: "Category", kind: "select", fromSchema: "requests.category" },
      { name: "amount", label: "Amount (USD)", kind: "number" }],
    onSubmit: async (v) => {
      try {
        await clay.db.insert("requests", { ...v, stage: "submitted",
          submitted_on: clay.compute.now().slice(0, 10) });
        clay.ui.toast("Request submitted - it enters the workflow at Submitted", "success");
      } catch (e) { clay.ui.toast("Could not submit: " + e.message, "danger"); }
    } }));
}`,
};

export const SEED_PANELS: Record<string, PanelBlobInput[]> = {
  blank: [],
  tracker: [items_flow, items_table, status_counts, add_item_form],
  log: [entries_table, per_week_chart, quick_add_form],
  dashboard: [metrics_row, records_table, by_category_chart, add_record_form],
  small_business: [
    sb_dashboard, sb_upcoming, sb_jobs_board, sb_jobs_table,
    sb_revenue, sb_invoices, sb_customers, sb_add_job,
  ],
  crm,
  financials,
  staff,
  habits: [habits_overview, habits_board, habits_table, streak_chart, add_habit_form],
  inventory: [inv_overview, inv_low, inv_table, inv_stock_chart, add_product],
  approvals: [approvals_overview, request_flow, requests_table, activity_log, new_request_form],
  jobs: [jobs_overview, jobs_flow, jobs_table, jobs_activity, add_application],
  content: [content_overview, content_flow, content_timeline, content_table, add_post],
};
