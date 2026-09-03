# 03 — Kernel API Reference (ClayAPI v1)

The single global injected into panel sandboxes. This contract is the
load-bearing wall: expressive enough for real features, constrained enough
that generated code cannot harm data, privacy, or other panels. Versioned:
panels declare `api: 1`; breaking changes bump the version and old panels
keep running against a shim.

## 0. Conventions

All methods async unless noted. All errors are ClayError {code, message,
detail?}; codes are stable strings (E_TABLE_UNKNOWN, E_COLUMN_UNKNOWN,
E_VALIDATION, E_LIMIT, E_TYPE, E_EXPR, E_CONFLICT, E_INTERNAL). Panels are expected to
catch; uncaught errors trip the panel error boundary (doc 05 §7).

## 1. clay.db

### query(q: Query): Promise<Row[]>
Executes a compiled, parameterized read. Rows are plain JSON objects with
registered columns only. Limits: default limit 500, hard cap 5000
(E_LIMIT beyond). Panels may only query tables listed in their manifest's
declared_queries (structural match, doc 06 §5).
Relation fields project as `{id, table, label}` or arrays of those objects.
Lookup and rollup fields are live virtual values. A `contains` condition and
sorting on a relation use the visible label; `eq` continues to accept its stable
stored ID. Attachment fields expose only opaque attachment IDs to queries. File
bytes and attachment metadata are available only to trusted shell surfaces.

### watch(q: Query, cb): Unsubscribe   (sync return)
query + subscription. cb fires with fresh rows after any committed write to
tables referenced by q (debounced 50ms). Max 8 watches per panel (E_LIMIT).
Unsubscribe is automatic on panel teardown.

### insert(table, row): Promise<Row>
Validates against registry: required fields present, types coerced
(ISO dates, numbers), enum values legal, unknown keys rejected (E_VALIDATION).
Fills id (uuidv7), created_at, updated_at. Returns the stored row.

All three write calls require both manifest membership in `declared_writes`
and a recent user action signalled by the fixed vnode runtime. One rendered
action grants at most 8 writes for 5 seconds so an async form or workflow can
complete atomically; module-boot and background writes are rejected.
Preview bridges are read-only. Data-entry controls unlock after Keep, so a
shadow interaction can never create a row that silently disappears on commit.

### update(table, id, patch): Promise<Row>
Same validation on patch. Computed columns are rejected as targets (E_TYPE).
Missing id -> E_VALIDATION.

### softDelete(table, id): Promise<void>
Sets deleted_at. Queries exclude soft-deleted rows unless the Query sets
includeDeleted: true (used by the Data view; panels may but rarely should).

There is no hard delete, raw SQL, DDL, or panel-accessible multi-row update.
The trusted Data view has a separate atomic batch API with receipts and stale
undo protection. It is intentionally absent from the sandbox Bridge.

### The Query type

```ts
type Query = {
  from: string;
  select?: string[];              // registered column names only
  where?: Condition[];            // implicitly AND-ed
  orWhere?: Condition[][];        // OR of AND-groups (bounded: <=4 groups)
  orderBy?: {field: string; dir: "asc"|"desc"}[];   // <=3
  groupBy?: string[];             // <=2
  aggregate?: {fn: "count"|"sum"|"avg"|"min"|"max";
               field: string; as: string}[];         // <=5
  limit?: number;
  includeDeleted?: boolean;
};
type Condition = {
  field: string;
  op: "eq"|"neq"|"gt"|"gte"|"lt"|"lte"|"contains"|"in"|
      "is_null"|"not_null"|"within_days"|"older_than_days";
  value?: Json;                   // absent for null ops
};
```
within_days/older_than_days compare date columns to now() — these two ops
alone cover most "overdue / expiring soon" intents and keep date math out of
generated code.

## 2. clay.ui

### render(vnode: VNode): void  (sync)
Replaces the panel's DOM with the vnode tree. Must be called at least once
within 2s of boot (else boundary trips E_RENDER_TIMEOUT). Re-render is cheap;
panels typically call render inside watch callbacks.

### The vnode vocabulary

```
h(tag, props, ...children)
```
Allowed tags — layout: div, span, section, h1..h3, p, ul, li, hr.
Kernel components (capitalized): Table, Chart, MetricCard, Badge, Form,
Field, Button, Input, Select, DatePicker, Checkbox, Toggle, EmptyState,
Stack, Grid, FilterBar, Board, Cards, Flow, Timeline, and Calendar.

Selected component contracts:

Table {columns: {field, label, format?, badge?}[], rows, onRowClick?,
       sortable?} — format: "date"|"currency"|"number"|"text"|"files";
       badge: {field, map: {value -> "green"|"amber"|"red"|"gray"}}.
Chart {kind: "bar"|"line"|"pie"|"area", data: {x, y}[] | series[],
       xLabel?, yLabel?, height?} — kernel wraps the chart lib; panels
       declare spec only.
Form {fields: FieldSpec[], initial?, submitLabel, onSubmit(values)} —
       validation derives from the registry automatically.
MetricCard {label, value, format?, trend?: {value, dir}}.
FilterBar {filters: {field, kind: "select"|"search"|"daterange"}[],
       onChange(state)} — state is plain JSON a panel feeds into where[].

Styling: no style/class props. Visual props are enumerated tokens:
tone ("default"|"accent"|"success"|"warning"|"danger"), size ("sm"|"md"),
emphasis ("solid"|"soft"). The kernel maps tokens to the design system —
generated UI cannot be ugly in new ways, only in known ways.

Event handlers allowed: onClick, onSubmit, onChange, onRowClick. Handlers
run inside the sandbox; they may call clay.* freely. The fixed renderer never
passes native DOM events or nodes into panel code. Handlers receive only their
documented plain-JSON payload, or no argument for a simple click.

### toast(msg, kind?), confirm(msg): Promise<boolean>
Rendered by the SHELL (outside the iframe) so panels cannot spoof system UI.
confirm is rate-limited (1 concurrent, 5/min) to prevent dialog spam.

### openRecord(table, id): Promise<void>
Asks the trusted shell to open a record detail drawer. The Bridge accepts only a
valid record ID and a table already named in that panel's declared queries. It
returns no record data and grants no write authority. Table rows and canonical
record cards, flows, and calendar items invoke this automatically when they
carry an `id` and do not define a custom click handler.

## 3. clay.events

emit(name, payload) / on(name, cb): Unsubscribe.
Namespaced per app, routed through the kernel, payload must be Json,
<= 8KB, <= 20 emits/min per panel. Use case: a FilterBar panel broadcasting
filter state a chart panel consumes. No cross-app, no external delivery.

## 4. clay.compute

eval(expr, scope): number | string  (sync) — the safe expression language
(doc 04 §6). Throws E_EXPR on parse/type errors.
now(): IsoDateString.
daysBetween(a, b): number. formatCurrency(n, code?): string.

## 5. clay.meta  (all sync, read-only)

schema: the registry snapshot (tables, columns, types, enums) — panels
introspect instead of hardcoding; a well-generated panel renders columns
from schema so it survives adjacent migrations.
panelId, appVersion, placement.

## 6. Explicitly absent (and why)

fetch/network (exfiltration), timers beyond a kernel-provided
clay.ui.refreshEvery(seconds >= 30) (busy-loops), raw DOM (spoofing/consistency),
storage (bypass of the versioned store), dynamic import/eval (validator
integrity), cross-panel refs (coupling), Math.random is allowed; Date is
shimmed to kernel now() for testability.

## 7. Worked example (generated panel, canonical style)

```js
export default function (clay) {
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
                         label: `Needs attention: ${rows.length}` }),
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
}
```
