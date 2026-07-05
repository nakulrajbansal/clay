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

Composition patterns:
- GANTT: a Box(col) of rows; each row a Box(row) with a Text label and a
  Bar{offset,value} positioned by the item's start/end dates normalized to
  0..1 over the visible window. Or a single Scene of positioned rects.
- KANBAN: a Box(row, gap:"md") of columns; each column a Box(col) with a
  Text header and one Box(tone) card per row.
- CALENDAR: a Box(col) of week rows; each a Box(row) of 7 day cells (Box).
- GAUGE/PROGRESS: a Bar{value} with a Text caption, or a Scene arc.
Introspect clay.meta.schema and shape data in-panel to feed these.`;

// The API grammar carries two fields as JSON strings (see
// mutation-plan-api.json / hydrateApiPlan). The exemplars below show them
// as objects for readability; this note reconciles that with the wire form.
const WIRE_NOTE = `## Output encoding
Two fields are transmitted as JSON STRINGS, not inline objects:
- "migration": a JSON string of the migration object (or null).
- each entry of a panel's "declared_queries": a JSON string of one Query.
The exemplars show these as objects to be readable; emit them as strings.
Everything else is a normal JSON value.`;

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
