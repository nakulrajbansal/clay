# 10 — Architecture Decision Records (ADR log)

Format: context -> decision -> alternatives -> consequences. Binding until
superseded by a new entry.

ADR-001 Client-first; records never on server.
  Alt: conventional SaaS store. Rejected: kills the trust story, adds
  compliance surface, and the whole category's wedge is data dignity.
  Consequence: sync is harder later (accepted; version log is event-shaped
  to keep the door open).

ADR-002 SQLite-WASM in OPFS over IndexedDB.
  Alt: IndexedDB + custom query layer; PGlite. Rejected: IndexedDB pushes
  query semantics into hand-rolled code the model must target; PGlite is
  heavier with no v1 payoff. Consequence: dedicated worker requirement;
  Safari OPFS quirks owned in week 1.

ADR-003 Constrained Query objects instead of SQL from panels.
  Alt: read-only SQL with a parser/allowlist. Rejected: parsing SQL for
  safety is a losing game; objects give static dependency extraction free.
  Consequence: expressiveness ceiling — mitigated by within_days-style ops
  and the rejection-log roadmap.

ADR-004 Vnode vocabulary + kernel components; no raw DOM/React in panels.
  Alt: sandboxed React, or sanitized HTML strings. Rejected: bigger attack
  and inconsistency surface; validation becomes heuristic. Consequence:
  some intents inexpressible in v1 (measured, drives v1.1).

ADR-005 iframes (opaque origin) over Workers/QuickJS-WASM for panels.
  Alt: Worker (no DOM -> needs a render protocol anyway); QuickJS (strong
  but heavy, slower iteration). Rejected for v1 on shippability.
  Consequence: ~1–3MB per iframe overhead; cap 20 panels (acceptable).

ADR-006 No destructive migration ops; hide-not-drop; mandatory inverses.
  Alt: allow drops with confirmation. Rejected: one bad drop ends trust;
  storage cost of retained columns is trivial at personal scale.
  Consequence: version log semantics stay information-preserving (enables
  the honest time slider).

ADR-007 Linear history, truncate-on-branch.
  Alt: branching/DAG. Rejected: UX and semantics cost explodes; personal
  apps rarely need branches. Consequence: one destructive-ish operation
  (truncation) exists, guarded by an explicit warning.

ADR-008 Whole-panel replacement, never patches, from the model.
  Alt: diff/patch output. Rejected: patch application failures are a whole
  failure class; panels are small. Consequence: slightly more output tokens
  (pennies).

ADR-009 Model sees schemas and intent, never rows.
  Alt: include sample rows for better generation. Rejected: breaks P2,
  invites prompt injection via data, grows context. Consequence: the model
  occasionally guesses formats wrong — mitigated by registry type detail
  and the repair round.

ADR-010 One repair round, then visible failure.
  Alt: agentic retry loops. Rejected: unbounded cost/latency, and silent
  struggle erodes trust more than honest failure. Consequence: first-pass
  quality is existential -> P0.1 exemplars + nightly gate.

ADR-011 Hosted proxy AND BYO key, both first-class from day one.
  Alt: BYO-only (no backend) or hosted-only. Rejected: BYO-only caps the
  audience; hosted-only weakens the trust anchor. Consequence: ~500-line
  backend maintained.

ADR-012 Panels communicate only via kernel-routed events.
  Alt: shared state object. Rejected: coupling + integrity risk.
  Consequence: FilterBar/Chart pairs need the event pattern (exemplar 6).

ADR-013 Two-layer plan validation: simplified schema at the API, full Zod
  client-side. (Decided in G1; entry back-filled per G26.)
  Alt: push the full MutationPlan schema into the structured-output
  grammar. Rejected: API grammar complexity caps can't hold nested
  Query/Condition/op constraints, and coupling the grammar to every schema
  change defeats caching. Consequence: the API guarantees parseability
  only; packages/schema (Zod) + Validator remain the sole correctness
  gate; mutation-plan-api.json is kept byte-stable.

ADR-014 Panels declare writes, not just reads (declared_writes).
  Context: doc 03 scoped declared_queries to reads while doc 06 checked
  "table access" per call — write access was unspecified (G22).
  Alt 1: writes unrestricted to any registered table. Rejected: violates
  least privilege; a buggy generated panel could corrupt unrelated tables.
  Alt 2: infer write tables from code statically without a declaration.
  Rejected: the manifest should be reviewable without executing code, and
  V4's declare-then-verify pattern already exists for reads.
  Consequence: PanelArtifact gains declared_writes (<= 4 tables); Bridge
  enforces at call time; V4 verifies write-call table literals against it;
  one more field the model must emit (taught by exemplar 5).

ADR-015 A validated upstream panel_error Bridge message.
  Context: the error boundary (doc 05 §7) needs runtime failure signals
  (uncaught errors, render timeout) from inside the iframe; the protocol
  had no Panel->Kernel path that isn't a call.
  Alt 1: encode as a BridgeCall. Rejected: calls carry seq + replies and
  count against the rate limit; error reporting must not be droppable by
  the panel's own budget exhaustion. Alt 2: shell-side watchdog only.
  Rejected: the shell can detect silence (timeout) but not error detail.
  Consequence: BridgePanelError {v, kind, code<=40, message<=500}; the
  Bridge forwards it to a hook without a strike; content is untrusted —
  used only for display and as sanitized repair-prompt input.

ADR-016 Expand the vnode vocabulary with composable primitives (revises
  ADR-004's fixed-component-set consequence, not its principle).
  Context: the eight named components can't express whole classes of
  intent (gantt, kanban, calendar, timeline, gauge, custom viz). ADR-004
  foresaw this as "measured, drives v1.1"; hitting it repeatedly IS that
  measurement.
  Alt 1: raw HTML/React panels. REJECTED — on the pre-decided "no" list
  (doc 01 §3): untrusted DOM means XSS, exfiltration, and system-UI
  spoofing; the Validator could no longer reason about output.
  Alt 2: keep adding named components forever. Rejected: always a gap
  behind the next request.
  DECISION: add four SAFE, composable primitives to the kernel-rendered
  set — Box (flex/grid container, enumerated tokens only), Text, Bar
  (proportional, offset+value → gantt rows/progress/meters), and Scene (a
  constrained SVG canvas: rect|line|text|circle|path shapes with numeric
  coords + token fills, textContent labels, shape cap). These COMPOSE into
  arbitrary in-frame layouts while every element stays a known vnode: no
  script, no raw DOM, no style/class props, nothing escapes the panel
  frame (doc 06 §4 intact). The security model (ADR-004/005, sandbox, CSP,
  Validator) is UNCHANGED — only the safe drawing surface widens.
  Consequence: renderer + PANEL_GLOBALS gain the four; the prompt teaches
  them; the Validator needs no change (it never allow-listed tags, and the
  primitives add no query/write surface). Model quality at composing novel
  layouts is a prompt-tuning loop, watched via the new diagnostics.

ADR-017 Panel placement gains an optional width span (direct-manip resize).
  Context: the layout was a single main column; users want panels side by
  side and resizable (B4/doc 13). A free 2D grid with per-panel {x,y,w,h}
  would be a large migration of the placement shape and the reshape
  vocabulary.
  DECISION: extend placement with an OPTIONAL w ∈ {1,2} (column span);
  default 1 when absent, so all existing panels/exemplars are unchanged.
  The main region renders as a 2-column grid; a w=2 panel spans both. Width
  is set by direct manipulation and committed via commitLayout as a normal
  reversible version (same one-history moat as reorder). The API grammar
  schema is UNCHANGED (the model still emits only region+order); w is a
  client/direct-manipulation concern only.
  Alt: full free-form grid ({x,y,w,h}). Deferred — heavier migration, and
  a 2-col span already resolves the "everything in one column" complaint.
  Consequence: schema placement + PanelBlobInput gain optional w; the grid
  CSS and a header resize toggle honor it; reorder preserves each panel's w.

ADR-018 Finer panel widths (4-col grid) and a resizable height.
  Context: ADR-017's w ∈ {1,2} gave only half/full — users asked to grab an
  edge/corner and resize more freely (and to see where a drag will land).
  DECISION: the main region becomes a 4-COLUMN grid; placement.w ∈ {1,2,3,4}
  is the column span (quarter/half/three-quarter/full), default HALF (2) when
  absent. placement also gains an optional h (pixel height, 80–2000) for
  continuous vertical resize (main + side panels). Both are set by edge/corner
  drag and committed via commitLayout as normal reversible versions; the API
  grammar is UNCHANGED (the model still never emits w/h — auto-widen now sets
  boards/timelines to w=4). A ONE-TIME store migration (guarded by a
  sys.settings 'layout_scheme' flag) remaps every stored blob's old width so
  proportions are preserved: w:1 (old half) → 2, w:2 (old full) → 4. This is
  safe because pre-018 apps only ever stored w ∈ {1,2}.
  Alt: full free-form {x,y,w,h} grid — still deferred as too heavy; a 4-col
  span + height covers the resize asks. Alt: store height in localStorage
  (non-versioned) — rejected; layout is part of the reversible history (P2).
  Consequence: schema/PanelBlobInput placement gain wider w + h; seed panels
  and hydrate auto-widen use w=4 for full; PanelFrame renders per-span grid
  columns and applies h; edge/bottom/corner handles drive commitLayout.
