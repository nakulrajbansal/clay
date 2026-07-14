// The vnode vocabulary (doc 03 §2, ADR-004): panels build plain trees with
// h(); this renderer turns them into DOM using ONLY whitelisted tags and
// kernel components. Everything is textContent — no innerHTML anywhere.
// W1 implements the components the archetype panels need; the rest of the
// vocabulary lands with the shell (W2).

export type VChild = VNode | string | number | null | false | undefined;
export type VNode = {
  clay_vnode: true;
  tag: string;
  props: Record<string, unknown>;
  children: VChild[];
};

// Component markers — injected as globals into panel scope.
export const Table = "Table";
export const Chart = "Chart";
export const MetricCard = "MetricCard";
export const Badge = "Badge";
export const Form = "Form";
export const Field = "Field";
export const Button = "Button";
export const Input = "Input";
export const Select = "Select";
export const DatePicker = "DatePicker";
export const Checkbox = "Checkbox";
export const Toggle = "Toggle";
export const EmptyState = "EmptyState";
export const Stack = "Stack";
export const Grid = "Grid";
export const FilterBar = "FilterBar";
// Composable primitives (ADR-016): compose into arbitrary in-frame layouts
// — gantt (Scene/Bar), kanban (Box columns), calendar (Box grid), etc.
export const Box = "Box";
export const Text = "Text";
export const Bar = "Bar";
export const Scene = "Scene";
// View components (the multi-view workhorses for business apps): one
// dataset shown as a kanban board or a card grid.
export const Board = "Board";
export const Cards = "Cards";
export const Timeline = "Timeline";

export const PANEL_GLOBALS: Record<string, unknown> = {
  Table, Chart, MetricCard, Badge, Form, Field, Button, Input, Select,
  DatePicker, Checkbox, Toggle, EmptyState, Stack, Grid, FilterBar,
  Box, Text, Bar, Scene, Board, Cards, Timeline,
};

const LAYOUT_TAGS = new Set(["div", "span", "section", "h1", "h2", "h3", "p", "ul", "li", "hr"]);
const TONES = new Set(["default", "accent", "success", "warning", "danger",
  "green", "amber", "red", "gray"]);
const HANDLERS: Record<string, string> = {
  onClick: "click", onSubmit: "submit", onChange: "change",
};

export function h(tag: string, props?: Record<string, unknown> | null, ...children: VChild[]): VNode {
  if (typeof tag !== "string") throw new Error("E_RENDER: tag must be a string");
  return { clay_vnode: true, tag, props: props ?? {}, children: children.flat(3) as VChild[] };
}

function isVNode(x: unknown): x is VNode {
  return typeof x === "object" && x !== null && (x as VNode).clay_vnode === true;
}

// ---------- badge maps (G25: literal keys, or threshold keys on numbers) ----------
const THRESHOLD = /^(<=|>=|<|>)(-?\d+(?:\.\d+)?)$/;

export function resolveBadgeTone(value: unknown, map: Record<string, string>): string | null {
  for (const [key, tone] of Object.entries(map)) {
    if (!TONES.has(tone)) continue;
    if (String(value) === key) return tone;
    const m = THRESHOLD.exec(key);
    if (m && typeof value === "number") {
      const bound = Number(m[2]);
      const ok = m[1] === "<" ? value < bound : m[1] === "<=" ? value <= bound
        : m[1] === ">" ? value > bound : value >= bound;
      if (ok) return tone;
    }
  }
  return null;
}

function formatCell(value: unknown, format: unknown): string {
  if (value === null || value === undefined) return "";
  switch (format) {
    case "date": return String(value).slice(0, 10);
    case "currency":
      return typeof value === "number"
        ? new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(value)
        : String(value);
    case "number":
      return typeof value === "number" ? value.toLocaleString() : String(value);
    default: return String(value);
  }
}

// ---------- renderer ----------
/** Registry snapshot shape delivered at boot (backs fromSchema, G25). */
export type SchemaTable = {
  name: string;
  columns: { name: string; type: string; values?: string[] }[];
};
type Ctx = { doc: Document; schema: SchemaTable[] };

function el(ctx: Ctx, tag: string, className?: string): HTMLElement {
  const node = ctx.doc.createElement(tag);
  if (className) node.className = className;
  return node;
}

function applyTokensAndHandlers(node: HTMLElement, props: Record<string, unknown>): void {
  const tone = props.tone;
  if (typeof tone === "string" && TONES.has(tone)) node.classList.add(`clay-tone-${tone}`);
  const size = props.size;
  if (size === "sm" || size === "md") node.classList.add(`clay-size-${size}`);
  const emphasis = props.emphasis;
  if (emphasis === "solid" || emphasis === "soft") node.classList.add(`clay-emphasis-${emphasis}`);
  for (const [prop, event] of Object.entries(HANDLERS)) {
    const fn = props[prop];
    if (typeof fn === "function") {
      node.addEventListener(event, (e) => { e.preventDefault(); (fn as (e: Event) => void)(e); });
      // interactive elements get the pointer cursor + hover affordance
      if (event === "click") node.classList.add("clay-clickable");
    }
  }
  // style/class/id and anything else are deliberately ignored (doc 03 §2)
}

function buildBadge(ctx: Ctx, label: unknown, tone: unknown,
  onClick?: unknown): HTMLElement {
  const node = el(ctx, "span", "clay-badge");
  if (typeof tone === "string" && TONES.has(tone)) node.classList.add(`clay-tone-${tone}`);
  node.textContent = String(label ?? "");
  // Badges are commonly used as click targets (cycle status, filter). Wire
  // the handler and show it is interactive — silently dropping onClick was
  // a real defect (clickable badges did nothing).
  if (typeof onClick === "function") {
    node.classList.add("clay-clickable", "clay-badge-clickable");
    node.addEventListener("click", (e) => {
      e.preventDefault();
      (onClick as (e: Event) => void)(e);
    });
  }
  return node;
}

type TableColumn = {
  field: string; label?: string; format?: string;
  badge?: { field: string; map: Record<string, string> };
};

function buildTable(ctx: Ctx, props: Record<string, unknown>): HTMLElement {
  const columns = (Array.isArray(props.columns) ? props.columns : []) as TableColumn[];
  const rows = (Array.isArray(props.rows) ? props.rows : []) as Record<string, unknown>[];
  const sortable = props.sortable === true;
  const onRowClick = props.onRowClick;
  const wrap = el(ctx, "div", "clay-table-wrap");
  const table = el(ctx, "table", "clay-table");
  // Give each column a floor so a narrow (half-width) panel scrolls
  // horizontally with every column readable, instead of cramming/clipping
  // them. Kicks in at 4+ columns (roughly the point a w:1 panel overflows).
  if (columns.length >= 4) table.style.minWidth = `${columns.length * 94}px`;

  // Click-to-sort (interactivity): headers toggle asc/desc; numeric columns
  // sort numerically, everything else lexically. Sort is per-render (resets
  // when the watch re-renders with fresh data) — no cross-render state.
  let sortField: string | null = null;
  let sortDir: 1 | -1 = 1;
  const carets = new Map<string, Text>();
  const compare = (a: Record<string, unknown>, b: Record<string, unknown>): number => {
    const va = a[sortField!]; const vb = b[sortField!];
    if (va == null || va === "") return vb == null || vb === "" ? 0 : 1;
    if (vb == null || vb === "") return -1;
    const na = Number(va); const nb = Number(vb);
    const c = !Number.isNaN(na) && !Number.isNaN(nb)
      ? na - nb : String(va).localeCompare(String(vb));
    return c * sortDir;
  };

  const tbody = el(ctx, "tbody");
  const fillBody = (): void => {
    tbody.textContent = "";
    const rr = sortField ? [...rows].sort(compare) : rows;
    for (const row of rr) {
      const tr = el(ctx, "tr");
      if (typeof onRowClick === "function") {
        tr.classList.add("clay-clickable");
        tr.addEventListener("click", () => (onRowClick as (r: unknown) => void)(row));
      }
      for (const col of columns) {
        const td = el(ctx, "td");
        const value = row[col.field];
        if (col.badge) {
          const tone = resolveBadgeTone(row[col.badge.field], col.badge.map ?? {});
          td.appendChild(buildBadge(ctx, formatCell(value, col.format), tone ?? "gray"));
        } else {
          td.textContent = formatCell(value, col.format);
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  };

  const thead = el(ctx, "thead");
  const headRow = el(ctx, "tr");
  for (const col of columns) {
    const th = el(ctx, "th");
    th.appendChild(ctx.doc.createTextNode(col.label ?? col.field));
    if (sortable) {
      th.classList.add("clay-th-sort");
      const caret = ctx.doc.createTextNode("");
      carets.set(col.field, caret);
      th.appendChild(caret);
      th.addEventListener("click", () => {
        if (sortField === col.field) sortDir = (sortDir === 1 ? -1 : 1) as 1 | -1;
        else { sortField = col.field; sortDir = 1; }
        for (const c of carets.values()) c.textContent = "";
        caret.textContent = sortDir === 1 ? " ↑" : " ↓";
        fillBody();
      });
    }
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);
  fillBody();
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function buildComponent(ctx: Ctx, node: VNode): HTMLElement {
  const { tag, props } = node;
  switch (tag) {
    case Table: return buildTable(ctx, props);
    case Badge: return buildBadge(ctx, props.label, props.tone, props.onClick);
    case EmptyState: {
      const div = el(ctx, "div", "clay-empty");
      div.textContent = String(props.label ?? "");
      return div;
    }
    case Stack: return el(ctx, "div", "clay-stack");
    case Grid: return el(ctx, "div", "clay-grid");
    case Button: {
      const btn = el(ctx, "button", "clay-button");
      btn.textContent = String(props.label ?? "");
      applyTokensAndHandlers(btn, props);
      return btn;
    }
    case MetricCard: {
      const card = el(ctx, "div", "clay-metric");
      const label = el(ctx, "span", "clay-metric-label");
      label.textContent = String(props.label ?? "");
      const value = el(ctx, "span", "clay-metric-value");
      value.textContent = formatCell(props.value, props.format);
      card.append(label, value);
      return card;
    }
    case Form: return buildForm(ctx, props);
    case FilterBar: return buildFilterBar(ctx, props);
    case Chart: return buildChart(ctx, props);
    case Box: return buildBox(ctx, props);
    case Text: return buildText(ctx, props);
    case Bar: return buildBar(ctx, props);
    case Scene: return buildScene(ctx, props);
    case Board: return buildBoard(ctx, props);
    case Cards: return buildCards(ctx, props);
    case Timeline: return buildTimeline(ctx, props);
    case Field: {
      const wrap = el(ctx, "label", "clay-field");
      const span = el(ctx, "span", "clay-field-label");
      span.textContent = String(props.label ?? "");
      wrap.appendChild(span);
      return wrap;
    }
    case Input: return buildControl(ctx, "text", props);
    case DatePicker: return buildControl(ctx, "date", props);
    case Checkbox: case Toggle: return buildControl(ctx, "checkbox", props);
    case Select: {
      const select = buildSelect(ctx,
        (Array.isArray(props.options) ? props.options : []) as FieldOption[],
        props.value);
      const onChange = props.onChange;
      if (typeof onChange === "function")
        select.addEventListener("change", () =>
          (onChange as (v: string) => void)(select.value));
      return select;
    }
    default:
      throw new Error(`E_RENDER: unknown tag '${tag}'`);
  }
}

// ---------- form vocabulary (doc 03 §2 + G25 FieldSpec) ----------
type FieldOption = { value: string; label?: string };
type FieldSpec = {
  name: string; label?: string;
  kind?: "text" | "number" | "date" | "select" | "checkbox";
  options?: FieldOption[];
  fromSchema?: string;          // "table.column" -> registry enum (G25)
  required?: boolean;
};

function schemaOptions(ctx: Ctx, ref: string): FieldOption[] {
  const [table, column] = ref.split(".");
  const col = ctx.schema.find(t => t.name === table)
    ?.columns.find(c => c.name === column);
  return (col?.values ?? []).map(v => ({ value: v, label: v }));
}

function buildSelect(ctx: Ctx, options: FieldOption[], value: unknown): HTMLSelectElement {
  const select = el(ctx, "select", "clay-select") as HTMLSelectElement;
  for (const o of options) {
    const opt = el(ctx, "option") as HTMLOptionElement;
    opt.value = o.value;
    opt.textContent = o.label ?? o.value;
    select.appendChild(opt);
  }
  if (typeof value === "string") select.value = value;
  return select;
}

function buildControl(ctx: Ctx, type: string, props: Record<string, unknown>): HTMLInputElement {
  const input = el(ctx, "input", "clay-input") as HTMLInputElement;
  input.type = type;
  if (typeof props.placeholder === "string") input.placeholder = props.placeholder;
  if (type === "checkbox") input.checked = props.checked === true;
  else if (props.value !== undefined && props.value !== null) input.value = String(props.value);
  const onChange = props.onChange;
  if (typeof onChange === "function")
    input.addEventListener("change", () =>
      (onChange as (v: unknown) => void)(type === "checkbox" ? input.checked : input.value));
  return input;
}

function buildForm(ctx: Ctx, props: Record<string, unknown>): HTMLElement {
  const fields = (Array.isArray(props.fields) ? props.fields : []) as FieldSpec[];
  const initial = (props.initial ?? {}) as Record<string, unknown>;
  const form = el(ctx, "form", "clay-form") as HTMLFormElement;
  const controls = new Map<string, { spec: FieldSpec; input: HTMLInputElement | HTMLSelectElement }>();

  for (const spec of fields) {
    const wrap = el(ctx, "label", "clay-field");
    const span = el(ctx, "span", "clay-field-label");
    span.textContent = spec.label ?? spec.name;
    wrap.appendChild(span);
    const kind = spec.kind ?? "text";
    let input: HTMLInputElement | HTMLSelectElement;
    if (kind === "select") {
      const options = spec.fromSchema
        ? schemaOptions(ctx, spec.fromSchema)
        : (spec.options ?? []);
      input = buildSelect(ctx,
        [{ value: "", label: "—" }, ...options], initial[spec.name]);
    } else {
      input = buildControl(ctx,
        kind === "number" ? "number" : kind === "date" ? "date"
          : kind === "checkbox" ? "checkbox" : "text", {});
      if (kind === "checkbox") (input as HTMLInputElement).checked = initial[spec.name] === true;
      else if (initial[spec.name] !== undefined) input.value = String(initial[spec.name]);
    }
    input.setAttribute("name", spec.name);
    wrap.appendChild(input);
    form.appendChild(wrap);
    controls.set(spec.name, { spec, input });
  }

  const submit = el(ctx, "button", "clay-button clay-form-submit") as HTMLButtonElement;
  // type=button, NOT submit: the panel sandbox is allow-scripts only, and
  // browsers block native form submission there (no allow-forms — kept
  // that way on purpose, doc 06 §2). Values are collected by hand.
  submit.type = "button";
  submit.textContent = String(props.submitLabel ?? "Save");
  form.appendChild(submit);

  const onSubmit = props.onSubmit;
  const doSubmit = (): void => {
    if (typeof onSubmit !== "function") return;
    const values: Record<string, unknown> = {};
    for (const [name, { spec, input }] of controls) {
      const kind = spec.kind ?? "text";
      if (kind === "checkbox") values[name] = (input as HTMLInputElement).checked;
      else if (input.value === "") continue;   // omit untouched optionals
      else if (kind === "number") values[name] = Number(input.value);
      else values[name] = input.value;
    }
    (onSubmit as (v: Record<string, unknown>) => void)(values);
  };
  submit.addEventListener("click", doSubmit);
  form.addEventListener("submit", (e) => { e.preventDefault(); doSubmit(); });
  form.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    const target = e.target as HTMLElement | null;
    if (key === "Enter" && target?.tagName !== "TEXTAREA") {
      e.preventDefault();
      doSubmit();
    }
  });
  return form;
}

function buildFilterBar(ctx: Ctx, props: Record<string, unknown>): HTMLElement {
  type FilterSpec = { field: string; kind: "select" | "search" | "daterange";
    options?: FieldOption[] };
  const filters = (Array.isArray(props.filters) ? props.filters : []) as FilterSpec[];
  const onChange = props.onChange;
  const bar = el(ctx, "div", "clay-filterbar");
  const state: Record<string, unknown> = {};
  const emit = (): void => {
    if (typeof onChange === "function")
      (onChange as (s: Record<string, unknown>) => void)({ ...state });
  };
  for (const f of filters) {
    if (f.kind === "select") {
      const select = buildSelect(ctx, f.options ?? [], undefined);
      select.setAttribute("name", f.field);
      select.addEventListener("change", () => { state[f.field] = select.value; emit(); });
      bar.appendChild(select);
    } else if (f.kind === "search") {
      const input = buildControl(ctx, "search", { placeholder: f.field });
      input.setAttribute("name", f.field);
      input.addEventListener("input", () => { state[f.field] = input.value; emit(); });
      bar.appendChild(input);
    } else {
      const from = buildControl(ctx, "date", {});
      const to = buildControl(ctx, "date", {});
      const update = (): void => {
        state[f.field] = { from: from.value, to: to.value }; emit();
      };
      from.addEventListener("change", update);
      to.addEventListener("change", update);
      bar.append(from, to);
    }
  }
  return bar;
}

// ---------- Chart: dependency-free SVG renderer ----------
// Doc 03 §2: panels declare a spec; the kernel draws it. This SVG renderer
// satisfies the contract without a chart library in the sandbox; swapping
// in an SRI-pinned chart lib (doc 06 §6) is tracked as OPEN-QUESTIONS Q20.
const SVG_NS = "http://www.w3.org/2000/svg";
const CHART_W = 400;
const MAX_POINTS = 200;
// Series palette for multi-series (comparison) charts — planned vs actual,
// this year vs last, etc. First colour is the accent so single-series stays
// on-brand; the rest are legible against it.
const SERIES_COLORS = ["#6a67e6", "#f0a54e", "#34c05f", "#e5688b", "#37b6c4", "#b07de8"];

// A "point" is {x, y:number}; a "series" is {label?, data:point[]}. The model
// reaches for the series shape whenever it wants to compare two things on one
// chart, so we must render it — a flat single-series array is the other case.
function shortX(x: string): string {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(x);
  if (d) return `${Number(d[2])}/${Number(d[3])}`;
  const w = /^\d{4}-W(\d{1,2})$/.exec(x);          // ISO week key -> "W01"
  if (w) return `W${w[1]!.padStart(2, "0")}`;
  const ym = /^(\d{4})-(\d{2})$/.exec(x);          // year-month -> "Jan '26"
  if (ym) {
    const mo = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(ym[2]) - 1];
    if (mo) return `${mo} '${ym[1]!.slice(2)}`;
  }
  return x.length > 7 ? `${x.slice(0, 6)}…` : x;
}

// Compact value label for bar tops: 1500 -> "1.5k", 12 -> "12", 3.25 -> "3.3".
function fmtNum(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}k`;
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 10) / 10);
}

function buildChart(ctx: Ctx, props: Record<string, unknown>): HTMLElement {
  const kind = typeof props.kind === "string" ? props.kind : "bar";
  const height = typeof props.height === "number" ? props.height : 200;
  const raw = Array.isArray(props.data) ? props.data : [];
  // Multi-series: any element carries its own `data` array (e.g. planned vs
  // actual). Route to the grouped/multi-line renderer so it doesn't silently
  // vanish through the single-series filter below.
  if (raw.some(d => d !== null && typeof d === "object" && Array.isArray((d as { data?: unknown }).data)))
    return buildMultiSeriesChart(ctx, kind, height, raw);

  const data = raw
    .filter((d): d is { x: unknown; y: number } =>
      typeof d === "object" && d !== null && typeof (d as { y: unknown }).y === "number")
    .slice(0, MAX_POINTS);

  const wrap = el(ctx, "figure", "clay-chart");
  const svg = ctx.doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${CHART_W} ${height}`);
  svg.setAttribute("role", "img");
  wrap.appendChild(svg);
  if (data.length === 0) return wrap;

  const rawMax = Math.max(...data.map(d => d.y), 0) || 1;
  // Headroom above the tallest bar so value labels have room to breathe.
  const maxY = kind === "pie" ? rawMax : rawMax * 1.16;
  const pad = 4;
  // Reserve a strip for x-axis labels on bar/line/area (pie doesn't use yFor).
  const showTicks = kind !== "pie" && data.length <= 12;
  const axisH = showTicks ? 14 : pad;
  const plotH = height - pad - axisH;
  const yFor = (y: number): number => pad + plotH - (Math.max(y, 0) / maxY) * plotH;
  const xTick = (cx: number, label: string): void => {
    const t = ctx.doc.createElementNS(SVG_NS, "text");
    t.setAttribute("x", String(cx)); t.setAttribute("y", String(height - 3));
    t.setAttribute("text-anchor", "middle"); t.setAttribute("font-size", "7");
    t.setAttribute("fill", "#a6a4b1"); t.setAttribute("class", "clay-chart-xtick");
    t.textContent = shortX(String(label));
    svg.appendChild(t);
  };

  if (kind === "pie") {
    const total = data.reduce((s, d) => s + Math.max(d.y, 0), 0) || 1;
    const cx = CHART_W / 2; const cy = height / 2;
    const r = Math.min(cx, cy) - pad;
    let angle = -Math.PI / 2;
    data.forEach((d, i) => {
      const color = SERIES_COLORS[i % SERIES_COLORS.length]!;
      const sweep = (Math.max(d.y, 0) / total) * Math.PI * 2;
      const x1 = cx + r * Math.cos(angle); const y1 = cy + r * Math.sin(angle);
      angle += sweep;
      const x2 = cx + r * Math.cos(angle); const y2 = cy + r * Math.sin(angle);
      const path = ctx.doc.createElementNS(SVG_NS, "path");
      // A full circle (single slice) needs two arcs — one path to (x2,y2)
      // when they coincide degenerates to nothing.
      path.setAttribute("d", data.length === 1
        ? `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} Z`
        : `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${sweep > Math.PI ? 1 : 0} 1 ${x2} ${y2} Z`);
      path.setAttribute("class", "clay-chart-slice");
      path.setAttribute("fill", color);          // distinct colour per category
      const title = ctx.doc.createElementNS(SVG_NS, "title");
      const share = Math.round((Math.max(d.y, 0) / total) * 100);
      title.textContent = `${String(d.x)}: ${d.y} (${share}%)`;
      path.appendChild(title);
      svg.appendChild(path);
    });
    // Legend — a pie without one is unreadable.
    const legend = el(ctx, "figcaption", "clay-chart-legend");
    data.forEach((d, i) => {
      const item = el(ctx, "span", "lg");
      const sw = el(ctx, "span", "sw");
      sw.style.background = SERIES_COLORS[i % SERIES_COLORS.length]!;
      item.appendChild(sw);
      item.appendChild(ctx.doc.createTextNode(String(d.x)));
      legend.appendChild(item);
    });
    wrap.appendChild(legend);
    return wrap;
  }

  // baseline (bar/line/area share it)
  const baseline = ctx.doc.createElementNS(SVG_NS, "line");
  baseline.setAttribute("x1", String(pad)); baseline.setAttribute("x2", String(CHART_W - pad));
  baseline.setAttribute("y1", String(yFor(0))); baseline.setAttribute("y2", String(yFor(0)));
  baseline.setAttribute("class", "clay-chart-axis");
  svg.appendChild(baseline);

  if (kind === "line" || kind === "area") {
    const step = data.length > 1 ? (CHART_W - pad * 2) / (data.length - 1) : 0;
    const xs = data.map((_, i) => pad + i * step);
    const poly = data.map((d, i) => `${xs[i]},${yFor(d.y)}`).join(" ");
    // soft filled area beneath the line
    const fill = ctx.doc.createElementNS(SVG_NS, "polygon");
    fill.setAttribute("points", `${pad},${yFor(0)} ${poly} ${xs[data.length - 1]},${yFor(0)}`);
    fill.setAttribute("class", "clay-chart-areafill");
    svg.appendChild(fill);
    // crisp line on top
    const line = ctx.doc.createElementNS(SVG_NS, "polyline");
    line.setAttribute("points", poly);
    line.setAttribute("class", "clay-chart-line");
    svg.appendChild(line);
    // point dots
    data.forEach((d, i) => {
      const dot = ctx.doc.createElementNS(SVG_NS, "circle");
      dot.setAttribute("cx", String(xs[i])); dot.setAttribute("cy", String(yFor(d.y)));
      dot.setAttribute("r", "2.6"); dot.setAttribute("class", "clay-chart-dot");
      const title = ctx.doc.createElementNS(SVG_NS, "title");
      title.textContent = `${String(d.x)}: ${d.y}`;
      dot.appendChild(title);
      svg.appendChild(dot);
    });
    if (showTicks) data.forEach((d, i) => xTick(xs[i]!, String(d.x)));
    return wrap;
  }

  // bar (default)
  const slot = (CHART_W - pad * 2) / data.length;
  const showVals = data.length <= 10;
  data.forEach((d, i) => {
    const bx = pad + i * slot + slot * 0.12;
    const bw = slot * 0.76;
    const by = yFor(d.y);
    const rect = ctx.doc.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(bx));
    rect.setAttribute("width", String(bw));
    rect.setAttribute("y", String(by));
    rect.setAttribute("height", String(Math.max(yFor(0) - by, 0)));
    rect.setAttribute("rx", "4");
    rect.setAttribute("class", "clay-chart-bar");
    const title = ctx.doc.createElementNS(SVG_NS, "title");
    title.textContent = `${String(d.x)}: ${d.y}`;
    rect.appendChild(title);
    svg.appendChild(rect);
    if (showVals && d.y > 0) {
      const val = ctx.doc.createElementNS(SVG_NS, "text");
      val.setAttribute("x", String(bx + bw / 2)); val.setAttribute("y", String(by - 3));
      val.setAttribute("text-anchor", "middle"); val.setAttribute("font-size", "8");
      val.setAttribute("font-weight", "600"); val.setAttribute("fill", "#6d6b78");
      val.setAttribute("class", "clay-chart-val");
      val.textContent = fmtNum(d.y);
      svg.appendChild(val);
    }
    if (showTicks) xTick(bx + bw / 2, String(d.x));
  });
  return wrap;
}

// Grouped bars / overlaid lines for comparison charts, with a legend and
// x-axis ticks. Shares the plot maths with buildChart but keeps single-series
// (the common case) on its simpler, CSS-styled path.
function buildMultiSeriesChart(
  ctx: Ctx, kind: string, height: number, raw: unknown[],
): HTMLElement {
  const series = raw
    .filter((s): s is { label?: unknown; data: unknown[] } =>
      s !== null && typeof s === "object" && Array.isArray((s as { data?: unknown }).data))
    .map((s, i) => ({
      label: typeof s.label === "string" ? s.label : `Series ${i + 1}`,
      points: s.data
        .filter((p): p is { x: unknown; y: number } =>
          p !== null && typeof p === "object" && typeof (p as { y: unknown }).y === "number")
        .slice(0, MAX_POINTS),
    }))
    .filter(s => s.points.length > 0);

  const wrap = el(ctx, "figure", "clay-chart");
  if (series.length === 0) return wrap;

  // Ordered union of x categories across all series.
  const cats: string[] = [];
  const seen = new Set<string>();
  for (const s of series) for (const p of s.points) {
    const k = String(p.x);
    if (!seen.has(k)) { seen.add(k); cats.push(k); }
  }
  const valueOf = series.map(s => {
    const m = new Map<string, number>();
    for (const p of s.points) m.set(String(p.x), p.y);
    return m;
  });

  const showTicks = cats.length > 0 && cats.length <= 12;
  const axisH = showTicks ? 14 : 4;
  const pad = 4;
  const plotH = height - axisH - pad;
  const maxY = Math.max(1, ...series.flatMap(s => s.points.map(p => Math.max(p.y, 0))));
  const yFor = (y: number): number => pad + plotH - (Math.max(y, 0) / maxY) * plotH;
  const baseY = yFor(0);

  const svg = ctx.doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${CHART_W} ${height}`);
  svg.setAttribute("role", "img");
  wrap.appendChild(svg);

  const baseline = ctx.doc.createElementNS(SVG_NS, "line");
  baseline.setAttribute("x1", String(pad)); baseline.setAttribute("x2", String(CHART_W - pad));
  baseline.setAttribute("y1", String(baseY)); baseline.setAttribute("y2", String(baseY));
  baseline.setAttribute("class", "clay-chart-axis");
  svg.appendChild(baseline);

  const lineStep = cats.length > 1 ? (CHART_W - pad * 2) / (cats.length - 1) : 0;
  const groupSlot = (CHART_W - pad * 2) / Math.max(cats.length, 1);

  if (kind === "line" || kind === "area") {
    series.forEach((s, si) => {
      const color = SERIES_COLORS[si % SERIES_COLORS.length]!;
      const map = valueOf[si]!;
      const pts: string[] = [];
      cats.forEach((c, i) => {
        const y = map.get(c);
        if (y != null) pts.push(`${pad + i * lineStep},${yFor(y)}`);
      });
      if (pts.length === 0) return;
      const poly = ctx.doc.createElementNS(SVG_NS, "polyline");
      poly.setAttribute("points", pts.join(" "));
      poly.setAttribute("fill", "none");
      poly.setAttribute("stroke", color);
      poly.setAttribute("stroke-width", "2");
      poly.setAttribute("stroke-linejoin", "round");
      svg.appendChild(poly);
    });
  } else {
    const barW = (groupSlot * 0.8) / series.length;
    cats.forEach((c, i) => {
      series.forEach((s, si) => {
        const y = valueOf[si]!.get(c);
        if (y == null) return;
        const color = SERIES_COLORS[si % SERIES_COLORS.length]!;
        const rect = ctx.doc.createElementNS(SVG_NS, "rect");
        rect.setAttribute("x", String(pad + i * groupSlot + groupSlot * 0.1 + si * barW));
        rect.setAttribute("width", String(Math.max(barW, 0.5)));
        rect.setAttribute("y", String(yFor(y)));
        rect.setAttribute("height", String(Math.max(baseY - yFor(y), 0)));
        rect.setAttribute("rx", "2");
        rect.setAttribute("class", "clay-chart-mbar");
        rect.setAttribute("fill", color);
        const title = ctx.doc.createElementNS(SVG_NS, "title");
        title.textContent = `${s.label} · ${c}: ${y}`;
        rect.appendChild(title);
        svg.appendChild(rect);
      });
    });
  }

  if (showTicks) {
    cats.forEach((c, i) => {
      const cx = kind === "line" || kind === "area"
        ? pad + i * lineStep
        : pad + i * groupSlot + groupSlot / 2;
      const t = ctx.doc.createElementNS(SVG_NS, "text");
      t.setAttribute("x", String(cx));
      t.setAttribute("y", String(height - 3));
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("font-size", "7");
      t.setAttribute("fill", "#a6a4b1");
      t.setAttribute("class", "clay-chart-xtick");
      t.textContent = shortX(c);
      svg.appendChild(t);
    });
  }

  // Legend — the whole point of a comparison chart is telling series apart.
  const legend = el(ctx, "figcaption", "clay-chart-legend");
  series.forEach((s, si) => {
    const item = el(ctx, "span", "lg");
    const sw = el(ctx, "span", "sw");
    sw.style.background = SERIES_COLORS[si % SERIES_COLORS.length]!;
    item.appendChild(sw);
    item.appendChild(ctx.doc.createTextNode(s.label));
    legend.appendChild(item);
  });
  wrap.appendChild(legend);
  return wrap;
}

function build(ctx: Ctx, child: VChild): Node | null {
  if (child === null || child === undefined || child === false) return null;
  if (typeof child === "string" || typeof child === "number")
    return ctx.doc.createTextNode(String(child));
  if (!isVNode(child)) throw new Error("E_RENDER: not a vnode");
  const { tag } = child;
  let node: HTMLElement;
  if (LAYOUT_TAGS.has(tag)) {
    node = el(ctx, tag);
    applyTokensAndHandlers(node, child.props);
  } else {
    node = buildComponent(ctx, child);
  }
  for (const c of child.children) {
    const built = build(ctx, c);
    if (built) node.appendChild(built);
  }
  return node;
}

// ---------- composable primitives (ADR-016) ----------
const SIZES = new Set(["none", "xs", "sm", "md", "lg", "xl"]);
const clampTone = (t: unknown): string | null =>
  typeof t === "string" && TONES.has(t) ? t : null;
const clampNum = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : dflt;
  return Math.max(lo, Math.min(hi, n));
};

function buildBox(ctx: Ctx, props: Record<string, unknown>): HTMLElement {
  const box = el(ctx, "div", "clay-box");
  const cls = (name: unknown, allowed: Set<string>, prefix: string): void => {
    if (typeof name === "string" && allowed.has(name)) box.classList.add(`${prefix}-${name}`);
  };
  box.classList.add(props.direction === "row" ? "clay-box-row" : "clay-box-col");
  cls(props.gap ?? "md", SIZES, "clay-gap");
  cls(props.pad, SIZES, "clay-pad");
  cls(props.align, new Set(["start", "center", "end", "stretch"]), "clay-align");
  cls(props.justify, new Set(["start", "center", "end", "between"]), "clay-justify");
  if (props.wrap === true) box.classList.add("clay-box-wrap");
  if (props.grow === true) box.classList.add("clay-box-grow");
  const tone = clampTone(props.tone);
  if (tone) box.classList.add(`clay-tone-${tone}`);
  applyTokensAndHandlers(box, props);
  return box;
}

function buildText(ctx: Ctx, props: Record<string, unknown>): HTMLElement {
  const span = el(ctx, "span", "clay-text");
  if (typeof props.size === "string" && SIZES.has(props.size))
    span.classList.add(`clay-text-${props.size}`);
  if (props.weight === "bold") span.classList.add("clay-text-bold");
  if (props.muted === true) span.classList.add("clay-text-muted");
  const tone = clampTone(props.tone);
  if (tone) span.classList.add(`clay-tone-fg-${tone}`);
  if (props.value !== undefined && props.value !== null)
    span.textContent = String(props.value);
  return span;
}

function buildBar(ctx: Ctx, props: Record<string, unknown>): HTMLElement {
  // proportional bar. value/offset in 0..1: a gantt row is offset + value.
  const wrap = el(ctx, "div", "clay-bar");
  if (props.label !== undefined) {
    const label = el(ctx, "span", "clay-bar-label");
    label.textContent = String(props.label);
    wrap.appendChild(label);
  }
  const track = el(ctx, "div", "clay-bar-track");
  const fill = el(ctx, "div", "clay-bar-fill");
  const offset = clampNum(props.offset, 0, 1, 0);
  const value = clampNum(props.value, 0, 1, 0);
  fill.style.marginLeft = `${(offset * 100).toFixed(2)}%`;
  fill.style.width = `${(Math.min(value, 1 - offset) * 100).toFixed(2)}%`;
  const tone = clampTone(props.tone) ?? "accent";
  fill.classList.add(`clay-tone-${tone}`);
  track.appendChild(fill);
  wrap.appendChild(track);
  if (props.caption !== undefined) {
    const cap = el(ctx, "span", "clay-bar-caption");
    cap.textContent = String(props.caption);
    wrap.appendChild(cap);
  }
  return wrap;
}

const MAX_SHAPES = 2000;

function buildScene(ctx: Ctx, props: Record<string, unknown>): HTMLElement {
  // A constrained SVG canvas — the "draw anything" escape hatch. Pure
  // geometry: numeric coords, token fills, textContent labels. No script.
  const width = clampNum(props.width, 1, 4000, 400);
  const height = clampNum(props.height, 1, 4000, 200);
  const shapes = (Array.isArray(props.shapes) ? props.shapes : [])
    .slice(0, MAX_SHAPES) as Record<string, unknown>[];
  const wrap = el(ctx, "figure", "clay-scene");
  const svg = ctx.doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  wrap.appendChild(svg);
  const n = (v: unknown, dflt = 0): number =>
    typeof v === "number" && Number.isFinite(v) ? v : dflt;
  const toneClass = (t: unknown): string => {
    const tone = clampTone(t);
    return tone ? `clay-fill-${tone}` : "clay-fill-default";
  };
  for (const s of shapes) {
    let node: SVGElement | null = null;
    switch (s.kind) {
      case "rect": {
        node = ctx.doc.createElementNS(SVG_NS, "rect");
        node.setAttribute("x", String(n(s.x)));
        node.setAttribute("y", String(n(s.y)));
        node.setAttribute("width", String(Math.max(0, n(s.w))));
        node.setAttribute("height", String(Math.max(0, n(s.h))));
        if (typeof s.radius === "number") node.setAttribute("rx", String(clampNum(s.radius, 0, 40, 0)));
        node.setAttribute("class", toneClass(s.tone));
        break;
      }
      case "line": {
        node = ctx.doc.createElementNS(SVG_NS, "line");
        node.setAttribute("x1", String(n(s.x1)));
        node.setAttribute("y1", String(n(s.y1)));
        node.setAttribute("x2", String(n(s.x2)));
        node.setAttribute("y2", String(n(s.y2)));
        node.setAttribute("class", `clay-stroke-${clampTone(s.tone) ?? "gray"}`);
        break;
      }
      case "circle": {
        node = ctx.doc.createElementNS(SVG_NS, "circle");
        node.setAttribute("cx", String(n(s.cx)));
        node.setAttribute("cy", String(n(s.cy)));
        node.setAttribute("r", String(Math.max(0, n(s.r))));
        node.setAttribute("class", toneClass(s.tone));
        break;
      }
      case "text": {
        node = ctx.doc.createElementNS(SVG_NS, "text");
        node.setAttribute("x", String(n(s.x)));
        node.setAttribute("y", String(n(s.y)));
        node.setAttribute("class", `clay-scene-text clay-stroke-${clampTone(s.tone) ?? "gray"}`);
        node.textContent = String(s.text ?? "").slice(0, 120);
        break;
      }
      default:
        continue;   // unknown shape kinds are ignored, not fatal
    }
    if (s.label !== undefined && s.kind !== "text") {
      const title = ctx.doc.createElementNS(SVG_NS, "title");
      title.textContent = String(s.label);
      node.appendChild(title);
    }
    svg.appendChild(node);
  }
  return wrap;
}

// ---------- view components (kanban board, card grid) ----------
type CardSpec = {
  title?: unknown; subtitle?: unknown; badge?: unknown; badgeTone?: unknown;
  fields?: { label?: unknown; value?: unknown }[];
};

function buildCard(ctx: Ctx, card: CardSpec, large: boolean,
  onClick: unknown): HTMLElement {
  const c = el(ctx, "div", large ? "clay-card clay-card-lg" : "clay-card");
  const head = el(ctx, "div", "clay-card-head");
  const title = el(ctx, "div", "clay-card-title");
  title.textContent = String(card.title ?? "");
  head.appendChild(title);
  if (card.badge !== undefined && card.badge !== null)
    head.appendChild(buildBadge(ctx, card.badge, clampTone(card.badgeTone) ?? "gray"));
  c.appendChild(head);
  if (card.subtitle !== undefined && card.subtitle !== null) {
    const sub = el(ctx, "div", "clay-card-subtitle");
    sub.textContent = String(card.subtitle);
    c.appendChild(sub);
  }
  for (const f of Array.isArray(card.fields) ? card.fields : []) {
    const row = el(ctx, "div", "clay-card-field");
    const l = el(ctx, "span", "clay-card-field-label");
    l.textContent = String(f.label ?? "");
    const v = el(ctx, "span", "clay-card-field-value");
    v.textContent = String(f.value ?? "");
    row.append(l, v);
    c.appendChild(row);
  }
  if (typeof onClick === "function") {
    c.classList.add("clay-clickable");
    c.addEventListener("click", () => (onClick as (x: unknown) => void)(card));
  }
  return c;
}

function buildBoard(ctx: Ctx, props: Record<string, unknown>): HTMLElement {
  // A kanban board: the panel shapes rows into groups (e.g. by a status
  // enum); Board renders columns of cards. The natural interaction is
  // DRAGGING a card between columns (bidirectional, intentional) — the
  // panel wires onCardMove(card, toGroupKey) to change the record's group.
  // onCardClick is also supported for opening a card.
  type Group = { key?: unknown; label?: unknown; tone?: unknown; cards?: CardSpec[] };
  const groups = (Array.isArray(props.groups) ? props.groups : []) as Group[];
  const onCardClick = props.onCardClick;
  const onCardMove = props.onCardMove;
  const draggable = typeof onCardMove === "function";
  let dragged: { card: CardSpec; fromKey: string } | null = null;

  const board = el(ctx, "div", "clay-board");
  for (const g of groups) {
    const groupKey = String(g.key ?? g.label ?? "");
    const col = el(ctx, "div", "clay-board-col");
    const header = el(ctx, "div", "clay-board-header");
    const label = el(ctx, "span", "clay-board-label");
    label.textContent = String(g.label ?? g.key ?? "");
    const tone = clampTone(g.tone);
    if (tone) {
      label.classList.add(`clay-tone-fg-${tone}`);
      col.classList.add(`tcol-${tone}`);   // colored top accent per column
    }
    const cards = Array.isArray(g.cards) ? g.cards : [];
    const count = el(ctx, "span", "clay-board-count");
    count.textContent = String(cards.length);
    header.append(label, count);
    col.appendChild(header);

    if (draggable) {
      col.addEventListener("dragover", (e) => {
        e.preventDefault();
        col.classList.add("clay-board-col-over");
      });
      col.addEventListener("dragleave", () => col.classList.remove("clay-board-col-over"));
      col.addEventListener("drop", (e) => {
        e.preventDefault();
        col.classList.remove("clay-board-col-over");
        if (dragged && dragged.fromKey !== groupKey)
          (onCardMove as (c: CardSpec, k: string) => void)(dragged.card, groupKey);
        dragged = null;
      });
    }

    const list = el(ctx, "div", "clay-board-cards");
    for (const card of cards) {
      const cardEl = buildCard(ctx, card, false, onCardClick);
      if (draggable) {
        cardEl.setAttribute("draggable", "true");
        cardEl.classList.add("clay-card-draggable");
        cardEl.addEventListener("dragstart", (e) => {
          dragged = { card, fromKey: groupKey };
          (e as DragEvent).dataTransfer?.setData("text/plain", String(card.title ?? ""));
        });
        cardEl.addEventListener("dragend", () => {
          dragged = null;
          col.classList.remove("clay-board-col-over");
        });
      }
      list.appendChild(cardEl);
    }
    col.appendChild(list);
    board.appendChild(col);
  }
  return board;
}

function buildCards(ctx: Ctx, props: Record<string, unknown>): HTMLElement {
  const items = (Array.isArray(props.items) ? props.items : []) as CardSpec[];
  const onItemClick = props.onItemClick;
  const grid = el(ctx, "div", "clay-cards");
  for (const it of items) grid.appendChild(buildCard(ctx, it, true, onItemClick));
  return grid;
}

// ---------- Timeline / Gantt ----------
// The polished path for "show as a gantt/timeline". The panel maps rows to
// {label, start, end, at, tone, caption}; the component does ALL the date
// math, positioning, and axis. A row with start+end is a bar; a row with a
// single date (at, or only start) is a milestone marker. Responsive HTML —
// no hand-drawn geometry.
function buildTimeline(ctx: Ctx, props: Record<string, unknown>): HTMLElement {
  type Row = { label?: unknown; start?: unknown; end?: unknown; at?: unknown;
    tone?: unknown; caption?: unknown };
  const rows = (Array.isArray(props.rows) ? props.rows : []) as Row[];
  const parse = (d: unknown): number | null => {
    if (d === undefined || d === null || d === "") return null;
    const t = Date.parse(String(d));
    return Number.isNaN(t) ? null : t;
  };
  const times: number[] = [];
  for (const r of rows) for (const k of ["start", "end", "at"] as const) {
    const t = parse(r[k]); if (t !== null) times.push(t);
  }
  const fromT = parse(props.from) ?? (times.length ? Math.min(...times) : null);
  const toT = parse(props.to) ?? (times.length ? Math.max(...times) : null);

  const wrap = el(ctx, "div", "clay-timeline");
  if (fromT === null || toT === null || rows.length === 0) {
    const empty = el(ctx, "div", "clay-empty");
    empty.textContent = "No dated items to place on a timeline";
    wrap.appendChild(empty);
    return wrap;
  }
  const span = Math.max(1, toT - fromT);
  const pos = (t: number): number => Math.max(0, Math.min(1, (t - fromT) / span));
  const pct = (v: number): string => `${(v * 100).toFixed(2)}%`;
  const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);

  const axis = el(ctx, "div", "clay-timeline-axis");
  const a1 = el(ctx, "span"); a1.textContent = iso(fromT);
  const a2 = el(ctx, "span"); a2.textContent = iso(toT);
  axis.append(a1, a2);
  wrap.appendChild(axis);

  for (const r of rows) {
    const row = el(ctx, "div", "clay-timeline-row");
    const label = el(ctx, "span", "clay-timeline-label");
    label.textContent = String(r.label ?? "");
    row.appendChild(label);
    const track = el(ctx, "div", "clay-timeline-track");
    const tone = clampTone(r.tone) ?? "accent";
    const s = parse(r.start), e = parse(r.end), at = parse(r.at);
    if (s !== null && e !== null && e >= s) {
      const bar = el(ctx, "div", `clay-timeline-bar clay-fill-${tone}`);
      bar.style.left = pct(pos(s));
      bar.style.width = pct(Math.max(0.01, pos(e) - pos(s)));
      if (r.caption !== undefined && r.caption !== null) bar.textContent = String(r.caption);
      track.appendChild(bar);
    } else {
      const pt = at ?? s ?? e;
      if (pt !== null) {
        const marker = el(ctx, "div", `clay-timeline-marker clay-fill-${tone}`);
        marker.style.left = pct(pos(pt));
        marker.title = iso(pt);
        track.appendChild(marker);
        if (r.caption !== undefined && r.caption !== null) {
          const cap = el(ctx, "span", "clay-timeline-caption");
          cap.style.left = pct(pos(pt));
          cap.textContent = String(r.caption);
          track.appendChild(cap);
        }
      }
    }
    row.appendChild(track);
    wrap.appendChild(row);
  }
  return wrap;
}

export function render(
  vnode: VChild,
  container: Element,
  opts: { schema?: SchemaTable[] } = {},
): void {
  const doc = container.ownerDocument;
  const built = build({ doc, schema: opts.schema ?? [] }, vnode);
  container.replaceChildren(...(built ? [built] : []));
}
