// The hand-written seed panels for the three starter shells (G9).
// Ids and placements are BINDING per specs/shells/starter-shells.json
// (a drift test compares). Every panel must pass the Validator and boot
// against its seeded store — both are tested, so the first-run promise
// (US-01, zero network) is CI-backed.
import type { PanelBlobInput } from "@clay/kernel";

// ---------- tracker ----------
const items_table: PanelBlobInput = {
  panel_id: "items_table", title: "Items",
  placement: { region: "main", order: 0 },
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
  placement: { region: "main", order: 0, w: 2 },
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
  declared_queries: Q[], declared_writes: string[], code: string, w?: 1 | 2,
): PanelBlobInput => ({
  panel_id, title, placement: { region, order, ...(w === 2 ? { w: 2 } : {}) },
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
}`, 2),
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
}`, 2),
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
}`, 2),
  panel("staff_shifts", "All shifts", "main", 1,
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
  panel("staff_timeoff", "Time off", "main", 2,
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

export const SEED_PANELS: Record<string, PanelBlobInput[]> = {
  tracker: [items_table, status_counts, add_item_form],
  log: [entries_table, per_week_chart, quick_add_form],
  dashboard: [metrics_row, records_table, by_category_chart],
  small_business: [
    sb_dashboard, sb_upcoming, sb_jobs_board, sb_jobs_table,
    sb_revenue, sb_invoices, sb_customers, sb_add_job,
  ],
  crm,
  financials,
  staff,
};
