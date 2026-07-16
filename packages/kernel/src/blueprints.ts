// Blueprints (ADR-029): declarative specs for STANDARD panels, expanded
// deterministically into the same canonical code the seed panels use. The
// model emits one line — `//#blueprint {"kind":"table",...}` — instead of a
// full module; the pipeline expands it BEFORE validation, deriving
// declared_queries/declared_writes from the same spec so they cannot drift
// from the code (the classic V4 failure disappears for standard panels).
//
// This widens NOTHING: expansion is trusted-kernel string generation whose
// output goes through the same Validator and the same sandbox as
// hand-written code, and can express nothing custom code couldn't.
import type { Registry, RegTable } from "./registry";

export type BlueprintResult = {
  code: string;
  declared_queries: Record<string, unknown>[];
  declared_writes: string[];
};

type Spec = Record<string, unknown>;
const J = (v: unknown): string => JSON.stringify(v);

const TONES = ["green", "amber", "red", "gray", "accent", "success", "warning", "danger", "default"];
const CYCLE = ["gray", "accent", "amber", "green", "red"];

function fail(msg: string): never { throw new Error(msg); }

function table(reg: Registry, name: unknown): RegTable {
  const t = reg.get(String(name ?? ""));
  return t ?? fail(`blueprint: unknown table '${String(name)}'`);
}

function col(t: RegTable, name: unknown, what: string): string {
  const n = String(name ?? "");
  if (!t.columns.some(c => c.name === n && !c.hidden))
    fail(`blueprint: ${what} '${n}' is not a column of '${t.name}'`);
  return n;
}

function orderBy(t: RegTable, spec: Spec): { field: string; dir: "asc" | "desc" }[] {
  const s = spec.sort as { field?: unknown; dir?: unknown } | undefined;
  if (!s?.field) return [];
  return [{ field: col(t, s.field, "sort field"),
    dir: s.dir === "desc" ? "desc" : "asc" }];
}

function baseQuery(t: RegTable, spec: Spec): Record<string, unknown> {
  const q: Record<string, unknown> = { from: t.name };
  if (Array.isArray(spec.where) && spec.where.length > 0) q.where = spec.where;
  const ob = orderBy(t, spec);
  if (ob.length > 0) q.orderBy = ob;
  if (typeof spec.limit === "number") q.limit = spec.limit;
  return q;
}

/** Auto tone map for an enum column: first value gray, terminal-ish green. */
function autoToneMap(values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  values.forEach((v, i) => {
    out[v] = /done|paid|complete|closed|won|published|approved|resolved/.test(v)
      ? "green" : CYCLE[i % CYCLE.length]!;
  });
  return out;
}

function badgeMap(t: RegTable, field: string, given: unknown): Record<string, string> {
  if (given && typeof given === "object" && !Array.isArray(given)) {
    const m = given as Record<string, string>;
    for (const tone of Object.values(m))
      if (!TONES.includes(tone)) fail(`blueprint: '${tone}' is not a tone`);
    return m;
  }
  const c = t.columns.find(x => x.name === field);
  return autoToneMap(c?.values ?? []);
}

const watchRender = (q: Record<string, unknown>, body: string): string =>
  `export default function (clay) {\n`
  + `  clay.db.watch(${J(q)}, (rows) => {\n${body}\n  });\n}`;

// ---------- kinds ----------

function bpTable(reg: Registry, spec: Spec): BlueprintResult {
  const t = table(reg, spec.table);
  type ColSpec = { field: unknown; label?: unknown; format?: unknown; badge?: unknown };
  const cols = (Array.isArray(spec.columns) && spec.columns.length > 0
    ? spec.columns as ColSpec[]
    : t.columns.filter(c => !c.hidden && c.type !== "json").slice(0, 6)
        .map(c => ({ field: c.name } as ColSpec)))
    .map(c => {
      const field = col(t, c.field, "column");
      const rc = t.columns.find(x => x.name === field)!;
      const entry: Record<string, unknown> = {
        field, label: String(c.label ?? field.replace(/_/g, " ")) };
      if (c.format) entry.format = c.format;
      else if (rc.type === "date") entry.format = "date";
      if (rc.type === "enum" || c.badge)
        entry.badge = { field, map: badgeMap(t, field, c.badge) };
      return entry;
    });
  const q = baseQuery(t, spec);
  const body =
    `    clay.ui.render(rows.length === 0\n`
    + `      ? h(EmptyState, { label: ${J(`No ${t.name} yet`)} })\n`
    + `      : h(Table, { sortable: true, rows, columns: ${J(cols)} }));`;
  return { code: watchRender(q, body), declared_queries: [q], declared_writes: [] };
}

function bpForm(reg: Registry, spec: Spec): BlueprintResult {
  const t = table(reg, spec.table);
  type FieldSpec = { name: unknown; label?: unknown; kind?: unknown; required?: unknown };
  const KIND: Record<string, string> = { text: "text", number: "number", integer: "number",
    date: "date", boolean: "checkbox", enum: "select" };
  const fields = (Array.isArray(spec.fields) && spec.fields.length > 0
    ? spec.fields as FieldSpec[]
    : t.columns.filter(c => !c.hidden && c.type !== "computed" && c.type !== "json")
        .slice(0, 7).map(c => ({ name: c.name } as FieldSpec)))
    .map(f => {
      const name = col(t, f.name, "field");
      const rc = t.columns.find(x => x.name === name)!;
      const entry: Record<string, unknown> = {
        name, label: String(f.label ?? name.replace(/_/g, " ")),
        kind: String(f.kind ?? KIND[rc.type] ?? "text") };
      if (rc.type === "enum") entry.fromSchema = `${t.name}.${name}`;
      if (f.required ?? rc.required) entry.required = true;
      return entry;
    });
  const defaults = (spec.defaults && typeof spec.defaults === "object")
    ? spec.defaults as Record<string, unknown> : {};
  for (const k of Object.keys(defaults)) col(t, k, "default");
  const code =
    `export default function (clay) {\n`
    + `  clay.ui.render(h(Form, {\n`
    + `    submitLabel: ${J(String(spec.submitLabel ?? "Add"))},\n`
    + `    fields: ${J(fields)},\n`
    + `    onSubmit: async (v) => {\n`
    + `      try {\n`
    + `        await clay.db.insert(${J(t.name)}, { ...v, ...${J(defaults)} });\n`
    + `        clay.ui.toast("Added", "success");\n`
    + `      } catch (e) { clay.ui.toast("Could not add: " + e.message, "danger"); }\n`
    + `    } }));\n}`;
  return { code, declared_queries: [], declared_writes: [t.name] };
}

function bpMetrics(reg: Registry, spec: Spec): BlueprintResult {
  const t = table(reg, spec.table);
  type M = { label: unknown; agg?: unknown; field?: unknown;
    where?: unknown; format?: unknown };
  const metrics = (Array.isArray(spec.metrics) ? spec.metrics : []) as M[];
  if (metrics.length === 0 || metrics.length > 6)
    fail("blueprint: metrics needs 1–6 entries");
  const queries: Record<string, unknown>[] = [];
  const cards: string[] = [];
  metrics.forEach((m, i) => {
    const agg = String(m.agg ?? "count");
    if (!["count", "sum", "avg", "min", "max"].includes(agg))
      fail(`blueprint: unknown agg '${agg}'`);
    const field = col(t, m.field ?? t.columns.find(c => !c.hidden)?.name, "metric field");
    const q: Record<string, unknown> = { from: t.name,
      aggregate: [{ fn: agg, field, as: "v" }] };
    if (Array.isArray(m.where) && m.where.length > 0) q.where = m.where;
    queries.push(q);
    const fmt = m.format === "currency"
      ? `, format: "currency"` : "";
    cards.push(
      `  clay.db.watch(${J(q)}, (rows) => {\n`
      + `    vals[${i}] = (rows[0] && rows[0].v) || 0; draw();\n  });`);
  });
  const labels = metrics.map(m => String(m.label));
  const formats = metrics.map(m => (m.format === "currency" ? "currency" : null));
  const code =
    `export default function (clay) {\n`
    + `  const vals = [${metrics.map(() => "0").join(", ")}];\n`
    + `  const labels = ${J(labels)};\n`
    + `  const formats = ${J(formats)};\n`
    + `  const draw = () => {\n`
    + `    clay.ui.render(h(Grid, {}, vals.map((v, i) =>\n`
    + `      h(MetricCard, formats[i]\n`
    + `        ? { label: labels[i], value: v, format: formats[i] }\n`
    + `        : { label: labels[i], value: v }))));\n`
    + `  };\n`
    + cards.join("\n") + `\n  draw();\n}`;
  return { code, declared_queries: queries, declared_writes: [] };
}

function bpChart(reg: Registry, spec: Spec): BlueprintResult {
  const t = table(reg, spec.table);
  const kind = String(spec.chart ?? "bar");
  if (!["bar", "line", "area", "pie"].includes(kind))
    fail(`blueprint: unknown chart '${kind}'`);
  const x = col(t, spec.x, "x");
  const agg = String(spec.agg ?? (spec.y ? "sum" : "count"));
  const y = col(t, spec.y ?? x, "y");
  const q: Record<string, unknown> = { from: t.name, groupBy: [x],
    aggregate: [{ fn: agg, field: y, as: "v" }] };
  if (Array.isArray(spec.where) && spec.where.length > 0) q.where = spec.where;
  const body =
    `    const data = rows.map((r) => ({ x: r[${J(x)}], y: r.v || 0 }));\n`
    + `    clay.ui.render(rows.length === 0\n`
    + `      ? h(EmptyState, { label: "No data yet" })\n`
    + `      : h(Chart, { kind: ${J(kind)}, height: ${Number(spec.height ?? 200)}, data }));`;
  return { code: watchRender(q, body), declared_queries: [q], declared_writes: [] };
}

function itemFields(t: RegTable, spec: Spec): { title: string; subtitle: string | null; badge: string | null } {
  const item = (spec.item ?? spec.card ?? {}) as Record<string, unknown>;
  const title = col(t, item.title ?? t.columns.find(c => !c.hidden)?.name, "title");
  const subtitle = item.subtitle ? col(t, item.subtitle, "subtitle") : null;
  const badge = item.badge ? col(t, item.badge, "badge") : null;
  return { title, subtitle, badge };
}

function bpBoard(reg: Registry, spec: Spec): BlueprintResult {
  const t = table(reg, spec.table);
  const group = col(t, spec.groupBy ?? spec.stage, "groupBy");
  const gc = t.columns.find(c => c.name === group)!;
  if (gc.type !== "enum") fail(`blueprint: board groupBy '${group}' must be an enum`);
  const values = gc.values ?? [];
  const tones = autoToneMap(values);
  const { title, subtitle } = itemFields(t, spec);
  const q = baseQuery(t, spec);
  const body =
    `    const groups = ${J(values)}.map((s) => ({ key: s, label: s, tone: ${J(tones)}[s],\n`
    + `      cards: rows.filter((r) => r[${J(group)}] === s)\n`
    + `        .map((r) => ({ id: r.id, title: r[${J(title)}]`
    + (subtitle ? `, subtitle: r[${J(subtitle)}]` : "") + ` })) }));\n`
    + `    clay.ui.render(h(Board, { groups, onCardMove: async (card, toKey) => {\n`
    + `      try { await clay.db.update(${J(t.name)}, card.id, { ${JSON.stringify(group).slice(1, -1)}: toKey });\n`
    + `      } catch (e) { clay.ui.toast("Could not move: " + e.message, "danger"); }\n`
    + `    } }));`;
  return { code: watchRender(q, body), declared_queries: [q], declared_writes: [t.name] };
}

function bpFlow(reg: Registry, spec: Spec): BlueprintResult {
  const t = table(reg, spec.table);
  const stageField = col(t, spec.stage ?? spec.groupBy, "stage");
  const sc = t.columns.find(c => c.name === stageField)!;
  if (sc.type !== "enum") fail(`blueprint: flow stage '${stageField}' must be an enum`);
  const given = Array.isArray(spec.stages) ? spec.stages as Spec[] : null;
  const stages = given
    ? given.map(s => ({ key: String(s.key), label: String(s.label ?? s.key),
        tone: TONES.includes(String(s.tone)) ? String(s.tone) : "gray" }))
    : (sc.values ?? []).map((v, i, arr) => ({ key: v, label: v.replace(/_/g, " "),
        tone: autoToneMap(arr)[v]! }));
  const { title, subtitle, badge } = itemFields(t, spec);
  // optional audit trail (ADR-025 convention): the activity table's item
  // column is its first required text column, falling back to first text
  let activityInsert = "";
  let activity: string | null = null;
  if (spec.activity) {
    const at = table(reg, spec.activity);
    activity = at.name;
    const itemCol = (at.columns.find(c => c.type === "text" && c.required)
      ?? at.columns.find(c => c.type === "text")
      ?? fail(`blueprint: activity table '${at.name}' needs a text column`)).name;
    for (const needed of ["from_stage", "to_stage"]) col(at, needed, "activity column");
    activityInsert =
      `          await clay.db.insert(${J(activity)}, { ${J(itemCol).slice(1, -1)}: item.title, `
      + `from_stage: item.stage, to_stage: toKey });\n`;
  }
  const q = baseQuery(t, spec);
  const body =
    `    const items = rows.map((r) => ({ id: r.id, title: r[${J(title)}],\n`
    + `      stage: r[${J(stageField)}], since: r.updated_at`
    + (subtitle ? `,\n      subtitle: r[${J(subtitle)}]` : "")
    + (badge ? `,\n      badge: r[${J(badge)}]` : "") + ` }));\n`
    + `    clay.ui.render(h(Flow, { stages: ${J(stages)}, items,\n`
    + `      onAdvance: async (item, toKey) => {\n`
    + `        try {\n`
    + `          await clay.db.update(${J(t.name)}, item.id, { ${J(stageField).slice(1, -1)}: toKey });\n`
    + activityInsert
    + `          clay.ui.toast(item.title + " \\u2192 " + toKey, "success");\n`
    + `        } catch (e) { clay.ui.toast("Could not move: " + e.message, "danger"); }\n`
    + `      } }));`;
  return { code: watchRender(q, body), declared_queries: [q],
    declared_writes: activity ? [t.name, activity] : [t.name] };
}

function bpCards(reg: Registry, spec: Spec): BlueprintResult {
  const t = table(reg, spec.table);
  const { title, subtitle, badge } = itemFields(t, spec);
  const q = baseQuery(t, spec);
  const body =
    `    clay.ui.render(rows.length === 0\n`
    + `      ? h(EmptyState, { label: ${J(`No ${t.name} yet`)} })\n`
    + `      : h(Cards, { items: rows.map((r) => ({ title: r[${J(title)}]`
    + (subtitle ? `, subtitle: r[${J(subtitle)}]` : "")
    + (badge ? `, badge: r[${J(badge)}]` : "") + ` })) }));`;
  return { code: watchRender(q, body), declared_queries: [q], declared_writes: [] };
}

function bpTimeline(reg: Registry, spec: Spec): BlueprintResult {
  const t = table(reg, spec.table);
  const label = col(t, spec.label ?? t.columns.find(c => !c.hidden)?.name, "label");
  const at = spec.at ? col(t, spec.at, "at") : null;
  const start = spec.start ? col(t, spec.start, "start") : null;
  const end = spec.end ? col(t, spec.end, "end") : null;
  if (!at && !start)
    fail("blueprint: timeline needs at (milestones) or start/end (bars)");
  const q = baseQuery(t, spec);
  const parts = [`label: r[${J(label)}]`];
  if (at) parts.push(`at: r[${J(at)}]`);
  if (start) parts.push(`start: r[${J(start)}]`);
  if (end) parts.push(`end: r[${J(end)}]`);
  const body =
    `    clay.ui.render(rows.length === 0\n`
    + `      ? h(EmptyState, { label: "Nothing scheduled yet" })\n`
    + `      : h(Timeline, { rows: rows.map((r) => ({ ${parts.join(", ")} })) }));`;
  return { code: watchRender(q, body), declared_queries: [q], declared_writes: [] };
}

function bpCalendar(reg: Registry, spec: Spec): BlueprintResult {
  const t = table(reg, spec.table);
  const date = col(t, spec.date, "date");
  const label = col(t, spec.label ?? t.columns.find(c => !c.hidden)?.name, "label");
  const q = baseQuery(t, spec);
  const body =
    `    clay.ui.render(rows.length === 0\n`
    + `      ? h(EmptyState, { label: "Nothing dated yet" })\n`
    + `      : h(Calendar, { items: rows.map((r) => ({ date: r[${J(date)}],\n`
    + `          label: r[${J(label)}] })) }));`;
  return { code: watchRender(q, body), declared_queries: [q], declared_writes: [] };
}

function bpFeed(reg: Registry, spec: Spec): BlueprintResult {
  const t = table(reg, spec.table);
  const title = col(t, spec.title ?? t.columns.find(c => !c.hidden)?.name, "title");
  const metaFields = (Array.isArray(spec.meta) ? spec.meta : [])
    .map(m => col(t, m, "meta"));
  const q: Record<string, unknown> = { from: t.name,
    orderBy: [{ field: "created_at", dir: "desc" }],
    limit: typeof spec.limit === "number" ? spec.limit : 12 };
  const metas = metaFields.map(f =>
    `,\n          h(Text, { value: String(r[${J(f)}] || ""), size: "xs", muted: true })`).join("");
  const body =
    `    clay.ui.render(rows.length === 0\n`
    + `      ? h(EmptyState, { label: "Nothing here yet" })\n`
    + `      : h(Stack, {}, rows.map((r) =>\n`
    + `        h(Box, { direction: "row", gap: "sm", align: "center" },\n`
    + `          h(Text, { value: r[${J(title)}], weight: "bold", size: "sm" })${metas}))));`;
  return { code: watchRender(q, body), declared_queries: [q], declared_writes: [] };
}

const KINDS: Record<string, (reg: Registry, spec: Spec) => BlueprintResult> = {
  table: bpTable, form: bpForm, metrics: bpMetrics, chart: bpChart,
  board: bpBoard, flow: bpFlow, cards: bpCards, timeline: bpTimeline,
  calendar: bpCalendar, feed: bpFeed,
};

export const BLUEPRINT_KINDS = Object.keys(KINDS);

/** Expand one spec. Throws with a human-fixable message on any problem —
 * the pipeline turns that into a validation issue the repair round sees. */
export function expandBlueprint(spec: unknown, reg: Registry): BlueprintResult {
  if (!spec || typeof spec !== "object" || Array.isArray(spec))
    fail("blueprint: spec must be a JSON object");
  const s = spec as Spec;
  const make = KINDS[String(s.kind ?? "")];
  if (!make) fail(`blueprint: unknown kind '${String(s.kind)}' — one of ${BLUEPRINT_KINDS.join(", ")}`);
  return make(reg, s);
}

/** The in-code directive form: a module whose body is a single directive. */
const DIRECTIVE = /^\s*\/\/#blueprint\s+(\{[\s\S]*\})\s*$/;

export function parseBlueprintDirective(code: string): unknown | null {
  const m = DIRECTIVE.exec(code);
  if (!m) return null;
  return JSON.parse(m[1]!);
}
