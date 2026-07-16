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

ADR-019 2D-lite grid placement: drag a panel to a specific column, gaps OK.
  Context: users want to place panels freely (e.g. top-right, leaving a gap),
  not just reorder a linear sequence. A full free-form {x,y} tile grid with a
  collision/compaction engine fights Clay's content-auto-sized panels (a rigid
  row grid forces fixed tile heights and scroll-in-tile, losing the nice
  auto-height).
  DECISION: placement gains an OPTIONAL col ∈ {0..3} — the start column in the
  4-col main grid. Set by dragging (snaps to the column under the cursor,
  clamped so the panel's width fits); absent = auto-flow (unchanged default).
  Rows still auto-flow (auto-height preserved), so this adds column pinning and
  HORIZONTAL gaps (leave a column empty) without a collision engine or a
  migration — existing panels simply have no col and flow as before. Committed
  via commitLayout as a reversible version; col:null clears a pin.
  Alt: full react-grid-layout {x,y,w,h} with compaction — deferred; heavier and
  it forces fixed tile heights, worse for Clay's variable content.
  Consequence: schema/PanelBlobInput placement gain optional col; reorder sets
  it on the dragged panel; PanelFrame renders grid-column start; the drop
  indicator shows the target column at the dragged width.

ADR-020 Kernel-derived inverses: the pipeline normalizes migration.inverse.
  Context: live traces show the model repeatedly writing migration inverses
  "undo-style" (reverse order) or with minor drift; V5/I2 then rejects the
  whole plan, and because panel checks fall back to the pre-migration
  registry, one root issue cascades into a wall of bogus V4 unknown-table
  issues — burning the single repair round on a formality the kernel can
  compute itself.
  DECISION: before S3 validation, MutationPipeline replaces plan.migration.
  inverse with deriveInverse(operations, registry) — the exact list the I2
  check demands. If deriveInverse throws (the forward ops themselves are
  invalid), the plan is left untouched so V5 reports the real problem. The
  schema still requires the model to emit an inverse (keeps reversibility in
  the plan contract and the model's attention on it); it is now advisory.
  Additionally, when validation fails with migration-level issues present,
  the repair prompt carries ONLY those (panel issues computed against the
  stale registry are downstream noise).
  Alt: drop inverse from the schema — rejected, schema change (constitution)
  with no grammar benefit; keeping it costs nothing. Alt: teach ordering in
  the prompt — tried implicitly via repair; nondeterministic and wastes the
  repair budget.
  Consequence: V5/I2 still guards hand-written and imported plans (store
  commits, exemplars, tests) — only model plans are normalized. Fixtures:
  pipeline.test.ts "model-mangled inverse" + "repair focuses on
  migration-level issues".

ADR-021 Pipeline appends missing V7 diff lines (same spirit as ADR-020).
  Context: a live run failed an otherwise-good exec-dashboard upgrade at
  V7 because the model's user_facing_diff lacked a [change_panel] line for
  one replaced panel — bookkeeping the kernel can compute from the plan
  itself. The repair round had already been spent on other issues.
  DECISION: before S3, the pipeline appends the exact missing lines using
  the SAME claim walk V7 checks (validate.ts missingDiffLines), so honesty
  and check can't drift. Lines use the eligible kind and the claim
  description as detail. The schema's 12-line cap is respected — if there
  is no room, nothing is appended and V7 reports normally. V7 still guards
  hand-written plans, and extra/unclaimed lines remain allowed.
  Consequence: fixture in pipeline.test.ts ("missing diff line is
  appended, not failed"). The preview card may show kernel-worded lines
  like "panel project_board (replaced)" when the model forgot its own.

ADR-022 Reshaping-UI roadmap R1-R4: packed grid, universal resize, local
  panel ops (rename/remove), scoped reshape seeds.
  Context: field feedback - uneven panel sizes left grid holes; top-region
  panels had no resize affordances at all; tiny edits (rename a title,
  drop a panel) forced a model round-trip, making Clay feel like a
  dashboard generator rather than a malleable app. 2025/26 malleability
  research (Ink & Switch "malleable software" essay's gentle slope; CHI'25
  generative+malleable task-driven UIs; CHI'26 conversational-
  customization probe) converges on: direct manipulation must own small
  changes, prompting owns structural ones, and both must share one
  reversible history. See doc 14 (reshaping roadmap) for the full mapping.
  DECISION:
  (a) Layout: top and main regions are the SAME 4-column grid; panels
      place masonry-style (1px implicit rows, row-span derived from the
      panel's measured height, dense auto-flow) so uneven sizes cannot
      leave holes. The placement schema is unchanged (region/order/w/h/col
      per ADR-018/019); the default span in top is 4 (full strip), main
      stays 2.
  (b) Resize: every top/main panel gets width AND height handles; side
      panels height only - the side rail is a fixed-width lane by design,
      and the resize path for a side panel is dragging it into main.
  (c) Local panel ops: ClayStore.renamePanel / removePanel commit through
      the SAME CommitInput vocabulary model plans use (panel blob rewrite /
      removePanels tombstone) - no model call, instant, reversible, one
      timeline with language reshapes (the commitLayout pattern, B4/doc
      13). No Bridge, Validator, or migration vocabulary was widened.
  (d) Scoped reshape: a per-panel affordance seeds the composer with
      'In the "<title>" panel: ' - pointing plus language in one gesture;
      the pipeline itself is untouched.
  Consequence: kernel tests cover rename/remove reversibility; packing and
  resize are exercised by scripts/reshapeui.mjs (no-model harness) plus
  the existing dragresize/verify2d harnesses.

ADR-023 Chart redesign: validated categorical palette as theme tokens +
  grid/scale/donut/tooltip upgrades to the sandbox SVG renderer.
  Context: field feedback "charts don't look good". Audit against current
  dataviz practice found: no y-scale or gridlines anywhere (magnitude
  unreadable), bars rounded on all four corners (float off the baseline),
  grouped bars touching, flat pie with unlimited slices, colliding 7px
  ticks, native <title> tooltips, and a hardcoded series palette whose
  green/orange adjacent pair measured CVD dE 2.0 under protanopia
  (indistinguishable for red-green colorblind users) with one hue outside
  the lightness band.
  DECISION:
  (a) Series colors move to CSS tokens --series-1..6 with two validated
      steppings: light (#6a67e6 #008300 #e87ba4 #eda100 #1baf7a #eb6834 on
      #ffffff) and dark (#7d7aec #00a300 #d55181 #c98500 #199e70 #d95926 on
      #1b1b24/#172230). Both pass the palette validator's hard gates
      (lightness band, chroma floor, adjacent-pair CVD dE >= 8, normal-
      vision floor >= 15). The ORDER is the colorblind-safety mechanism:
      never reorder, extend, or cycle. Light mode's contrast WARN on three
      hues is covered by the relief rule - legends name every series and
      bars carry direct value labels. The shell injects the stepping per
      theme (themes.ts); slot 1 stays Clay indigo so single-series charts
      remain on-brand.
  (b) Renderer (panel-runtime vnode.ts): nice axis maximum (1/2/2.5/5 x
      10^k) with 4 recessive gridlines + y labels in a 26-unit left
      gutter; bars become paths rounded ONLY at the data end, anchored
      square to the baseline; grouped bars get a 2-unit surface gap;
      pie becomes a donut (2px surface-stroke slice gaps, headline total
      in the hole, shares in the legend) folding beyond 5 categories into
      "Other"; crowded x-axes thin ticks to <= 8; every mark gets an
      instant theme-aware hover tooltip (shared div per figure, aria-label
      mirror) replacing native <title>; empty data renders "No data yet".
  Consequence: 6 new renderer tests (grid count, nice labels, baseline
  anchoring, donut fold + total, tooltip presence, tick thinning); the
  palette re-validation command is recorded here:
  validate_palette.js "<hexes>" --mode light|dark --surface <panel hex>.

ADR-024 Workflows: the Flow view component, taught + templated.
  Context: field feedback - "apps should have workflows too instead of
  just dashboards". Clay rendered STATE well (tables, boards, charts,
  metrics) but had no first-class way to express PROCESS: work moving
  through ordered stages with explicit advancing and visible progress.
  Board is adjacent but shows unordered columns you drag between; nothing
  said "this is a sequence, here is where each item sits, click to move
  it forward".
  DECISION:
  (a) New panel-runtime view component Flow{stages(ordered), items,
      onAdvance(item, toStageKey), onItemClick}: a stage rail with
      per-stage counts, a progress bar toward the final stage, items
      grouped in process order, and per-item advance/back buttons. The
      write path is EXACTLY Board's: the panel wires onAdvance to
      clay.db.update of the stage enum through declared_writes - no new
      Bridge, Validator, or migration vocabulary (the component is
      sandbox UI vocabulary, precedent ADR-016/#13/#18).
  (b) Taught: prompt.ts view-component list (Flow FIRST for any
      workflow/process/approval/pipeline-steps intent; Board=state,
      Flow=process) + exemplar 14-flow.md (stage enum reuse, $var-free
      declared queries, declared_writes) regenerated into assets.
  (c) Templated: new "approvals" starter shell (requests: submitted ->
      in_review -> approved -> paid) seeding an At-a-glance metric strip,
      the Request workflow Flow panel, a requests table, and a new-request
      form - the binding spec entry lives in starter-shells.json with the
      drift/validator/boot tests extending automatically.
  Also fixed in the same change: .onboarding-hero hardcoded a white
  gradient, rendering the "Start from scratch / Build" hero unreadable
  under dark themes; it now uses var(--panel)/var(--bg-soft)/var(--text).
  Consequence: 6 Flow unit tests (rail order+counts, progress, advance/
  back keys, done state, read-only, empty) + 4 approvals seed-boot tests.

ADR-025 Workflow guardrails: two-step advance + audit trail (revises
  ADR-024 after user review).
  Context: first-hand review of the Flow component - "you click on a
  button and it goes to the next step without any warning and no way to
  tell history of what was moved forward." Two real defects: advancing
  was a single accidental click, and transitions left no visible record
  (kernel row_history is an UNDO mechanism, not a queryable audit
  surface, and is reserved from panel queries by design).
  DECISION:
  (a) The Flow component's advance button is TWO-STEP: first click arms
      it (amber "Move to <stage>?" state), second click confirms;
      auto-disarms after 4s. This lives in the trusted component so every
      workflow gets it - panels must not stack dialogs on top (the
      ui.confirm rate limit would also make that path unusable). The
      back button stays single-click: it IS the corrective control.
  (b) Audit trail as DATA (data outlives interface): the approvals
      template gains a request_activity table (request, from_stage,
      to_stage, moved_on); onAdvance inserts a transition row after the
      stage update and toasts the move; a new Activity panel lists recent
      transitions newest-first. The exemplar + prompt vocabulary teach
      the same pattern (activity table + insert + toast + Activity
      panel, both tables in declared_writes) so GENERATED workflows ship
      with history, not only the template.
  Consequence: Flow unit tests assert arm-then-confirm (first click must
  NOT fire) and single-click back; seed-boot asserts the seeded activity
  renders. Verified live: counts 1/2/1/1 unchanged after the first click,
  0/3/1/1 after confirm, new "submitted -> in_review" row in Activity,
  toast shown.

ADR-026 Template audit round: three cross-cutting fixes + per-template
  gaps + two new templates (jobs, content).
  Context: a full e2e audit of all templates (scripts/templatereview.mjs:
  fresh profile per template, inventory, submit every form with plausible
  values, confirm a Flow advance, verify writes propagate, screenshot).
  It caught a P0: Bookkeeping's Record button was UNCLICKABLE.
  DECISION (cross-cutting):
  (a) Side-region panels use flex: 1 0 auto - a height-constrained side
      column compressed sections below their iframe (overflow: hidden
      clipped the form's submit button and parked the invisible bottom
      resize strip over it, swallowing every click).
  (b) The iframe runtime installs a ResizeObserver on body posting
      clay_resize - content height settles after first render (fonts,
      selects); a one-shot measure under-sized panels.
  (c) A click is not a resize: edge-handle gestures with <= 4px of travel
      are no-ops - previously a stray click on the strip committed a
      phantom "Rearranged the layout by hand" version.
  DECISION (per-template):
  tracker + items_flow (todo/doing/done IS a process); dashboard +
  add_record_form (a dashboard you cannot feed is read-only); habits +
  streak_chart; inventory + inv_stock_chart (stock vs reorder point,
  multi-series).
  DECISION (new templates): jobs (Job Applications: saved -> applied ->
  interview -> offer -> closed with app_activity audit trail) and content
  (Content Calendar: idea -> draft -> review -> scheduled -> published
  pipeline + a publish-date Timeline). Both follow the ADR-024/025
  workflow pattern.
  Consequence: 15 new seed-boot assertions; shells.test counts 13; the
  audit harness is repeatable (all 12 templates green: forms write and
  propagate, flows advance two-step, zero console errors).

ADR-027 Feature round: record history, Calendar view, Observer v3, local
  schema edits, felt reversibility, data egress, workflow conventions.
  Context: post-audit feature push. Each item deepens an existing
  principle rather than widening a surface.
  DECISION:
  (a) rowHistory(table, id) read API on ClayStore (G6 snapshots projected
      onto live columns, newest first) surfaced ONLY in the trusted Data
      editor: per-row clock toggle showing each record's history with the
      existing restoreRow as "restore previous values". row_history stays
      reserved from panel queries.
  (b) Calendar view component (month grid, tone chips per dated item,
      local month navigation) + prompt vocabulary + exemplar 15 + staff
      shift_calendar showcase. Never hand-compose month grids from Boxes.
  (c) Observer v3: process-not-flowed (an enum whose values read like an
      ordered pipeline on a table with no Flow view suggests a workflow;
      workflow-viewed tables also suppress the board nudge) and
      metric-not-charted (numeric column + date/enum slicer, >= 6 rows, no
      chart). Local heuristics only, P4 intact.
  (d) Local schema edits from the Data editor: add/rename column commit
      through the EXISTING migration vocabulary with kernel-derived
      inverses (worker schema-ops helper; commitLayout/ADR-022c
      precedent). Labels normalize to idents ("Due date" -> due_date);
      renames ride G16 query rewriting so panels follow.
  (e) Felt reversibility + data egress: Keep's toast carries a one-click
      Rewind (makeLatest to the prior version); per-table CSV download in
      the Data editor; a weekly backup nudge with one-click .clay export
      (last-backup timestamp in localStorage).
  (f) Workflow conventions taught to the planner: pass since:updated_at
      so Flow's stage-age badges light up (warnDays threshold, component-
      side); stamp stage-implied dates (paid_on) inside onAdvance; owner
      fields + "my queue" Flow variants on request. Template flows all
      pass since.
  Consequence: kernel rowHistory + Observer tests; shell schema-ops +
  seed-boot calendar tests; panel-runtime Calendar + aging tests; all
  taught surfaces regenerated into assets.

ADR-028 Backend Phase 1.2: magic-link auth + quotas + /me, dev-mode first.
  Context: doc 07 §1-3 requires auth, a 20/30d free quota, and a usage
  meter before deploy. Deploy itself (Phase 1.3) is blocked on hosting +
  email-provider credentials, so 1.2 ships fully testable without them.
  DECISION: an injectable AuthStore interface (MemoryAuthStore now; the
  Postgres adapter implements the same contract at deploy — atomic
  incrementUsage is the documented seam) + Sessions (15-min single-use
  magic tokens, 30d rolling sessions, 3 links/hour/email). Auth is OPT-IN
  on createApp: no auth option = Phase 1.1 open local proxy, keeping BYO
  and local dev first-class (doc 07 §6). AUTH=dev on the server turns on
  dev mode where the magic link returns in the response (no email hop).
  Sessions ride an httpOnly cookie AND an Authorization bearer echo (the
  callback returns the session id) so cross-origin dev works before the
  same-origin deploy. Plan calls meter; repairs are free per spec; 429
  carries the meter so the client can render "resets on <date>". /me
  feeds a usage meter in the rail (warm styling at >= 50%).
  Consequence: 6 backend tests (link->session->/me, rate limit,
  single-use tokens, 401 gating, quota exhaustion + free repairs, open
  local mode preserved). Deploy blockers recorded in OPEN-QUESTIONS.

ADR-029 Blueprints: declarative specs for standard panels, expanded
  pipeline-side into canonical code.
  Context: every reshape made the model hand-write full panel modules
  (~0.5-1.5k output tokens each) even for bog-standard tables and forms —
  the dominant cost in both latency and tokens — and hand-written
  declared_queries drifting from code was the #1 validation failure (V4).
  DECISION: a panel's code may be a single directive,
  `//#blueprint {"kind":...}`, for ten standard kinds (table, form,
  metrics, chart, board, flow, cards, timeline, calendar, feed). The
  pipeline expands directives BEFORE S3 validation (kernel
  blueprints.ts), generating the same canonical code the seed panels use
  and DERIVING declared_queries/declared_writes from the same spec — V4
  mismatches become structurally impossible for blueprint panels.
  Expansion runs against the POST-migration registry
  (validateMigrationPlan's projection), so a blueprint may target a table
  its own plan creates. Expansion failures become precise validation
  issues ("blueprint: unknown table 'ghost'") for the single repair
  round. Registry-aware defaults: table columns / form fields derive from
  the schema when omitted; enum columns get badge tone maps and Flow
  stages automatically; flows accept an activity table (ADR-025
  convention) and emit the audit insert.
  This widens NOTHING: the MutationPlan schema and API grammar are
  byte-identical (a directive is just a code string); expanded output
  goes through the same Validator and sandbox and can express nothing
  custom code couldn't. Custom module code remains fully supported and
  is still the path for non-standard panels.
  Consequence: prompt teaches blueprints as the PREFERRED form + exemplar
  16 (a whole app: migration + one line per panel); kernel tests assert
  every kind expands Validator-clean against a real registry, pipeline
  integration, and repair-visible errors. Live verify: a 6-panel build
  committed first-try with zero repairs, mixing directives and custom
  code.
