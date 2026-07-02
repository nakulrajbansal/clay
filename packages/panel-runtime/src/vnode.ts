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

export const PANEL_GLOBALS: Record<string, unknown> = {
  Table, Chart, MetricCard, Badge, Form, Field, Button, Input, Select,
  DatePicker, Checkbox, Toggle, EmptyState, Stack, Grid, FilterBar,
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
type Ctx = { doc: Document };

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
    case Chart: case Form: case Field: case Input: case Select:
    case DatePicker: case Checkbox: case Toggle: case FilterBar:
      throw new Error(`E_RENDER: component ${tag} lands in W2`);
    default:
      throw new Error(`E_RENDER: unknown tag '${tag}'`);
  }
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

export function render(vnode: VChild, container: Element): void {
  const doc = container.ownerDocument;
  const built = build({ doc }, vnode);
  container.replaceChildren(...(built ? [built] : []));
}
