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
const sb_jobs_board: PanelBlobInput = {
  panel_id: "sb_jobs_board", title: "Jobs board",
  placement: { region: "main", order: 0 },
  declared_queries: [{ from: "jobs" }],
  declared_writes: [],
  code: `export default function (clay) {
  const cols = ["lead", "scheduled", "in_progress", "done", "invoiced"];
  const tones = ${JOB_TONES};
  clay.db.watch({ from: "jobs" }, (rows) => {
    const groups = cols.map((s) => ({
      key: s, label: s.split("_").join(" "), tone: tones[s],
      cards: rows.filter((r) => r.status === s).map((r) => ({
        title: r.title, subtitle: r.customer,
        badge: r.price ? clay.compute.formatCurrency(r.price) : null })),
    }));
    clay.ui.render(h(Board, { groups }));
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

export const SEED_PANELS: Record<string, PanelBlobInput[]> = {
  tracker: [items_table, status_counts, add_item_form],
  log: [entries_table, per_week_chart, quick_add_form],
  dashboard: [metrics_row, records_table, by_category_chart],
  small_business: [
    sb_dashboard, sb_upcoming, sb_jobs_board, sb_jobs_table,
    sb_revenue, sb_invoices, sb_customers, sb_add_job,
  ],
};
