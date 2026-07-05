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

export const PANEL_GLOBALS: Record<string, unknown> = {
  Table, Chart, MetricCard, Badge, Form, Field, Button, Input, Select,
  DatePicker, Checkbox, Toggle, EmptyState, Stack, Grid, FilterBar,
  Box, Text, Bar, Scene,
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
    if (typeof fn === "function")
      node.addEventListener(event, (e) => { e.preventDefault(); (fn as (e: Event) => void)(e); });
  }
  // style/class/id and anything else are deliberately ignored (doc 03 §2)
}

function buildBadge(ctx: Ctx, label: unknown, tone: unknown): HTMLElement {
  const node = el(ctx, "span", "clay-badge");
  if (typeof tone === "string" && TONES.has(tone)) node.classList.add(`clay-tone-${tone}`);
  node.textContent = String(label ?? "");
  return node;
}

type TableColumn = {
  field: string; label?: string; format?: string;
  badge?: { field: string; map: Record<string, string> };
};

function buildTable(ctx: Ctx, props: Record<string, unknown>): HTMLElement {
  const columns = (Array.isArray(props.columns) ? props.columns : []) as TableColumn[];
  const rows = (Array.isArray(props.rows) ? props.rows : []) as Record<string, unknown>[];
  const table = el(ctx, "table", "clay-table");
  const thead = el(ctx, "thead");
  const headRow = el(ctx, "tr");
  for (const col of columns) {
    const th = el(ctx, "th");
    th.textContent = col.label ?? col.field;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = el(ctx, "tbody");
  for (const row of rows) {
    const tr = el(ctx, "tr");
    const onRowClick = props.onRowClick;
    if (typeof onRowClick === "function")
      tr.addEventListener("click", () => (onRowClick as (r: unknown) => void)(row));
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
  table.appendChild(tbody);
  return table;
}

function buildComponent(ctx: Ctx, node: VNode): HTMLElement {
  const { tag, props } = node;
  switch (tag) {
    case Table: return buildTable(ctx, props);
    case Badge: return buildBadge(ctx, props.label, props.tone);
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

function buildChart(ctx: Ctx, props: Record<string, unknown>): HTMLElement {
  const kind = typeof props.kind === "string" ? props.kind : "bar";
  const height = typeof props.height === "number" ? props.height : 200;
  const data = (Array.isArray(props.data) ? props.data : [])
    .filter((d): d is { x: unknown; y: number } =>
      typeof d === "object" && d !== null && typeof (d as { y: unknown }).y === "number")
    .slice(0, MAX_POINTS);

  const wrap = el(ctx, "figure", "clay-chart");
  const svg = ctx.doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${CHART_W} ${height}`);
  svg.setAttribute("role", "img");
  wrap.appendChild(svg);
  if (data.length === 0) return wrap;

  const maxY = Math.max(...data.map(d => d.y), 0) || 1;
  const pad = 4;
  const plotH = height - pad * 2;
  const yFor = (y: number): number => pad + plotH - (Math.max(y, 0) / maxY) * plotH;

  if (kind === "pie") {
    const total = data.reduce((s, d) => s + Math.max(d.y, 0), 0) || 1;
    const cx = CHART_W / 2; const cy = height / 2;
    const r = Math.min(cx, cy) - pad;
    let angle = -Math.PI / 2;
    for (const d of data) {
      const sweep = (Math.max(d.y, 0) / total) * Math.PI * 2;
      const x1 = cx + r * Math.cos(angle); const y1 = cy + r * Math.sin(angle);
      angle += sweep;
      const x2 = cx + r * Math.cos(angle); const y2 = cy + r * Math.sin(angle);
      const path = ctx.doc.createElementNS(SVG_NS, "path");
      path.setAttribute("d",
        `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${sweep > Math.PI ? 1 : 0} 1 ${x2} ${y2} Z`);
      path.setAttribute("class", "clay-chart-slice");
      const title = ctx.doc.createElementNS(SVG_NS, "title");
      title.textContent = `${String(d.x)}: ${d.y}`;
      path.appendChild(title);
      svg.appendChild(path);
    }
    return wrap;
  }

  if (kind === "line" || kind === "area") {
    const step = data.length > 1 ? (CHART_W - pad * 2) / (data.length - 1) : 0;
    const points = data.map((d, i) => `${pad + i * step},${yFor(d.y)}`);
    const node = ctx.doc.createElementNS(SVG_NS, kind === "area" ? "polygon" : "polyline");
    const path = kind === "area"
      ? `${pad},${yFor(0)} ${points.join(" ")} ${pad + (data.length - 1) * step},${yFor(0)}`
      : points.join(" ");
    node.setAttribute("points", path);
    node.setAttribute("class", `clay-chart-${kind}`);
    svg.appendChild(node);
    return wrap;
  }

  // bar (default)
  const slot = (CHART_W - pad * 2) / data.length;
  data.forEach((d, i) => {
    const rect = ctx.doc.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(pad + i * slot + slot * 0.1));
    rect.setAttribute("width", String(slot * 0.8));
    rect.setAttribute("y", String(yFor(d.y)));
    rect.setAttribute("height", String(Math.max(yFor(0) - yFor(d.y), 0)));
    rect.setAttribute("class", "clay-chart-bar");
    const title = ctx.doc.createElementNS(SVG_NS, "title");
    title.textContent = `${String(d.x)}: ${d.y}`;
    rect.appendChild(title);
    svg.appendChild(rect);
  });
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

export function render(
  vnode: VChild,
  container: Element,
  opts: { schema?: SchemaTable[] } = {},
): void {
  const doc = container.ownerDocument;
  const built = build({ doc, schema: opts.schema ?? [] }, vnode);
  container.replaceChildren(...(built ? [built] : []));
}
