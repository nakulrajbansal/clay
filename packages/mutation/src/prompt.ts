// Prompt assembly (doc 05 §3): the static SYSTEM prompt from spec-derived
// assets (byte-stable per deploy — prompt caching and the regression gate
// both depend on that), plus the dynamic user/repair turns. The user turn
// carries schema shapes and intent ONLY — never row data (ADR-009, P2).
import {
  API_REFERENCE, COMPONENT_CONTRACTS, EXEMPLARS, HARD_RULES,
  MIGRATION_VOCAB, OUTPUT_CONTRACT, ROLE,
} from "./assets.gen";

export const INTENT_MAX_CHARS = 500;         // S0 (doc 05 §1)
const CONTEXT_BUDGET_CHARS = 48_000;         // ~12k tokens (doc 05 §4)

export type S1PanelManifest = {
  id: string;
  title: string;
  placement: { region: string; order: number };
  declared_queries: unknown[];
  declared_writes: string[];
  /** one-line kernel-generated description (doc 05 §4) */
  description: string;
  /** full code ONLY for panels the intent targets (doc 05 §1 S1) */
  code?: string;
};

export type S1Context = {
  registry: { name: string; columns: unknown[] }[];
  panels: S1PanelManifest[];
  recentSummaries: string[];
  intent: string;
};

// Composable primitives (ADR-016): teach the model to tailor UI to any
// request by composing Box/Text/Bar/Scene, not just the named components.
const PRIMITIVES_NOTE = `## Composable UI primitives
Beyond the named components, four primitives compose into ANY in-frame
layout. Use them when the request needs something the named components
don't cover (timelines, boards, calendars, gauges, custom visuals). All
props are enumerated tokens or numbers — never CSS, never raw HTML.

- Box{direction:"row"|"col", gap, pad:"none"|"xs"|"sm"|"md"|"lg"|"xl",
      align:"start"|"center"|"end"|"stretch",
      justify:"start"|"center"|"end"|"between", wrap:bool, grow:bool,
      tone} — the universal flex container. Nest to build any layout.
- Text{value, size:"xs".."xl", weight:"bold", muted:bool, tone}.
- Bar{value:0..1, offset:0..1, label, caption, tone} — a proportional
  bar. A gantt/timeline ROW is a Bar where offset = start fraction and
  value = duration fraction along the row.
- Scene{width, height, shapes:[…]} — a constrained SVG canvas for
  drawing. shapes: {kind:"rect",x,y,w,h,radius?,tone?,label?} |
  {kind:"line",x1,y1,x2,y2,tone?} | {kind:"circle",cx,cy,r,tone?,label?} |
  {kind:"text",x,y,text,tone?}. Coordinates are viewBox units; tones are
  the standard tokens. Use for gantt bars, network diagrams, heatmaps,
  any bespoke visual.

Five ready-made VIEW components cover the most common business layouts —
ALWAYS prefer them over composing from primitives or Scene:
- Calendar{items:[{date,label,tone}], month?, onItemClick} — a month grid;
  each dated item lands on its day as a colored chip, with built-in ‹ ›
  month navigation. THIS is the answer to "calendar / month view /
  schedule by day" — never hand-compose a month from Boxes. Dates are ISO
  strings; items outside the shown month simply don't render.
- Flow{stages:[{key,label,tone}], items:[{id,title,subtitle,badge,badgeTone,
       stage,since}], onAdvance, onItemClick, warnDays?} — a staged PROCESS
       (workflow). stages
       are ORDERED (the process order); each item sits at one stage. Renders
       a stage rail with counts, a progress bar toward the final stage, and
       per-item "advance to next / send back" buttons. Wire
       onAdvance(item, toStageKey) to clay.db.update the record's stage enum.
       THIS is the answer to any "workflow / process / pipeline steps /
       approval chain / intake queue / move things through stages" request:
       Board shows STATE you drag between; Flow shows a PROCESS with
       one-click advancing and progress. Apps that track work through steps
       deserve a Flow panel, not only tables and charts. Advance buttons are
       two-step by design (click arms, click again confirms) — never add
       your own confirm dialog on top. WORKFLOWS DESERVE AN AUDIT TRAIL:
       give the app an activity table ({item, from_stage, to_stage, date}),
       have onAdvance insert a transition row after the stage update and
       toast the move, and add a compact Activity panel listing recent
       transitions (newest first). Both written tables go in
       declared_writes. More workflow conventions:
       · pass since: r.updated_at on each item — stuck work then shows an
         age badge automatically (warnDays tunes the threshold);
       · when a stage implies a date (paid_on, published_on, closed_on),
         SET it inside onAdvance when the item enters that stage;
       · for team-ish apps give records an owner field and, when asked for
         "my queue" / "waiting on me", add a Flow filtered to one owner,
         oldest first.
- Board{groups:[{key,label,tone,cards:[{title,subtitle,badge,badgeTone}]}],
        onCardMove, onCardClick} — a kanban board. Shape rows into groups
        yourself (e.g. group by a status enum), one group per column.
        onCardMove(card, toGroupKey) fires when a card is DRAGGED to another
        column — wire it to clay.db.update the record's group field. PREFER
        onCardMove: dragging is bidirectional and reversible, unlike a
        one-way click-to-advance. Use onCardClick only to open/inspect a card.
        Give each group a tone so its column is colour-coded.
- Cards{items:[{title,subtitle,badge,badgeTone,fields:[{label,value}]}],
        onItemClick} — a responsive grid of record cards.
- Timeline{rows:[{label,start,end,at,tone,caption}], from, to} — a
  gantt/timeline. A row with start AND end is a BAR spanning those dates;
  a row with only a single date (use "at", or just start) is a MILESTONE
  marker. Dates are ISO strings; the component computes the window and
  positions everything. THIS is the answer to any "show as a gantt /
  timeline / roadmap / schedule over time" request — never hand-draw a
  timeline with Scene. If items only have one date, milestones are the
  honest rendering; if you want spanning bars, note that a start date is
  needed.

Composition patterns (when no view component fits):
- CALENDAR: a Box(col) of week rows; each a Box(row) of 7 day cells (Box).
- GAUGE/PROGRESS: a Bar{value} with a Text caption, or a Scene arc.
Introspect clay.meta.schema and shape data in-panel to feed these.

MANY VIEWS OVER ONE DATASET: data lives in tables; a panel is one VIEW of
it. The same table is legitimately shown by several panels at once — a
board by status AND a table AND a dashboard count are all valid views of
the same rows. When a request asks for a new way to SEE existing data, add
a panel (a new view); only migrate the schema when new data must be
STORED. Prefer reusing existing tables/fields over inventing new ones.`;

// The API grammar carries two fields as JSON strings (see
// mutation-plan-api.json / hydrateApiPlan). The exemplars below show them
// as objects for readability; this note reconciles that with the wire form.
const WIRE_NOTE = `## Output encoding
Two fields are transmitted as JSON STRINGS, not inline objects:
- "migration": a JSON string of the migration object (or null).
- each entry of a panel's "declared_queries": a JSON string of one Query.
The exemplars show these as objects to be readable; emit them as strings.
Everything else is a normal JSON value.`;

// Preemptive constraint teaching: the format rules the client-side Zod
// constitution enforces. Stating them up front raises the first-pass
// commit rate (these are the shapes that otherwise fail and force a
// repair round).
const OUTPUT_RULES_NOTE = `## Get it right the first time
Your plan is validated against a strict schema. Follow these exactly:
- panel_id is snake_case: a lowercase letter then lowercase letters,
  digits, or underscores, at least 3 chars ("jobs_board", never
  "jobsBoard", "JobsBoard", or "jb"). REUSING an existing panel_id
  REPLACES that panel; a NEW id ADDS a panel.
- summary <= 200 chars, plain English, no code/SQL/jargon. Each
  user_facing_diff detail <= 120 chars. Keep both short.
- assumptions: at most 5, each <= 150 chars.
- When you change an existing panel you are given its full current code.
  Return the COMPLETE updated module (panels are whole-file replacements),
  keeping what still applies — do not omit unrelated parts.
- Reuse existing tables and fields. Migrate ONLY when new data must be
  stored; a new way to SEE existing data is a new panel with migration
  null. Prefer adding a view over changing the schema.
- Every db.query/db.watch shape you use appears in declared_queries;
  every table you insert/update/softDelete appears in declared_writes.
  If ANY panel code path calls db.update/insert/softDelete on a table,
  that table MUST be in that panel's declared_writes — this is the most
  common validation failure. A panel that only reads has declared_writes
  omitted or [].
- When a watch/query filters by a value from a VARIABLE (a row id, a
  captured constant, anything not a literal in the query object), declare
  that query with the wildcard value {"$var": true}, e.g.
  {"from":"items","where":[{"field":"id","op":"eq","value":{"$var":true}}]}.
  The Validator cannot resolve a variable to a literal, so a concrete
  declared value will NOT match and validation fails.
- When you REVISE an existing panel, PRESERVE its working behavior — keep
  its click handlers, forms, filters, and events unless the request is to
  change them. Don't drop interactivity while restyling.
- confidence < 0.5 => set clarifying_question and leave the plan empty;
  otherwise decide and record the choice in assumptions.

Interactivity: Badge, Box, Button, and Table rows all accept an onClick
(Table also onRowClick) — use them directly for clickable status chips,
selectable rows, etc. Clickable elements automatically show a pointer
cursor. Prefer the Timeline/Board/Cards/Table components over rebuilding
equivalents from Box/Text/Bar by hand.

Quality bar (make every panel feel finished — the styling is handled for you,
so lean into these):
- Tables: pass sortable:true (headers become click-to-sort) and render any
  status/enum column as a badge with a tone map
  (badge:{field,map:{done:"green",todo:"gray",blocked:"red"}}).
- Show status/enum values as coloured badges everywhere, not raw text; give
  Board columns and Timeline bars a tone.
- When a table has a meaningful numeric column, include a Chart summarising it
  (a count by category, or a sum over time) — a dashboard beats a bare list.
- Provide an EmptyState with a helpful label for any view that can be empty.
- Format money/dates/numbers via the Table column "format" (money|date|number)
  rather than raw values.`;

export function buildSystemPrompt(): string {
  const exemplars = EXEMPLARS.map((e, i) =>
    `### Exemplar ${i + 1}\nINTENT: ${e.intent}\n\n\`\`\`json\n${e.plan}\n\`\`\``,
  ).join("\n\n");
  return [
    ROLE,
    `## ClayAPI reference\n\n${API_REFERENCE}`,
    `## Migration vocabulary and invariants\n\n${MIGRATION_VOCAB}`,
    `## Output contract\n\n${OUTPUT_CONTRACT}`,
    `## Component contracts (G25)\n\n${COMPONENT_CONTRACTS}`,
    PRIMITIVES_NOTE,
    `## Hard rules\n\n${HARD_RULES}`,
    OUTPUT_RULES_NOTE,
    WIRE_NOTE,
    `## Exemplars\n\n${exemplars}`,
  ].join("\n\n");
}

export class MutationRequestError extends Error {
  constructor(readonly code: string, message: string, readonly detail?: unknown) {
    super(message);
    this.name = "MutationRequestError";
  }
}

export function buildUserTurn(ctx: S1Context): string {
  if (ctx.intent.length === 0 || ctx.intent.length > INTENT_MAX_CHARS)
    throw new MutationRequestError("E_VALIDATION",
      `intent must be 1..${INTENT_MAX_CHARS} chars`);

  // Budget trimming (doc 05 §4): drop panel code first, then descriptions,
  // least-recently-relevant last in the caller-provided order. The registry
  // is never dropped.
  const panels = ctx.panels.map(p => ({ ...p }));
  const render = (): string => [
    `<registry>${JSON.stringify(ctx.registry)}</registry>`,
    `<panels>${JSON.stringify(panels)}</panels>`,
    `<recent>${ctx.recentSummaries.map(s => `- ${s}`).join("\n")}</recent>`,
    `<intent>${ctx.intent}</intent>`,
  ].join("\n");

  let out = render();
  for (let i = panels.length - 1; i >= 0 && out.length > CONTEXT_BUDGET_CHARS; i--) {
    if (panels[i]!.code !== undefined) { delete panels[i]!.code; out = render(); }
  }
  for (let i = panels.length - 1; i >= 0 && out.length > CONTEXT_BUDGET_CHARS; i--) {
    panels[i]!.description = ""; out = render();
  }
  return out;
}

/** The repair turn (doc 05 §1 S2'): machine reasons + offending artifact. */
export function buildRepairTurn(failures: string[], offendingArtifact: string): string {
  return [
    `<failure>`,
    ...failures.map(f => `- ${f}`),
    ``,
    offendingArtifact,
    `</failure>`,
    `Return a corrected COMPLETE MutationPlan.`,
  ].join("\n");
}
