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

ADR-030 Build-3 iteration round: three live builds -> fixes + two new
  blueprint capabilities.
  Context: three brand-new apps built live end-to-end (OKR tracker, 2-day
  conference planner, book library) — all six model calls (3 builds + 3
  follow-up edits) committed FIRST TRY with zero repairs, zero console
  errors, zero panel boundaries; Observer v3 nudges and the workflow/
  calendar/timeline/FilterBar surfaces all fired live. The screenshots
  still exposed four real gaps.
  DECISION:
  (a) Sample fill never invents history: tables named *activity/*_log/
      *_history, or carrying a from_stage/to_stage pair, are skipped —
      audit trails fill themselves as the user advances items.
  (b) Domain-aware sample titles: title-ish columns draw from pools keyed
      by TABLE name (books/sessions/recipes/tracks), so a library shows
      "The Silent Harbor", not "Fix billing edge case".
  (c) Narrow panels tighten table type/padding via an in-iframe media
      query instead of clipping a badge mid-glyph.
  (d) Blueprint kind "progress" (label + value toward a column-or-constant
      max, tone by fraction — the OKR/goals/budget pattern) and table
      option "search"/"filters" (FilterBar + client-side filtering
      generated in ONE panel, no cross-panel events) — both taught and
      Validator-clean by test.
  Consequence: harness scripts/build3.mjs is repeatable; a closing live
  build ("reading goals") verified both new capabilities: 8 progress
  bars, search + season filter, filter narrowing 8 -> 5 rows live.

ADR-031 (2026-07-17) Serverless deploy target: durable sessions in Postgres
  CONTEXT: Phase 1.3 shipped a Fly.io container path where magic-link
  tokens, sessions, and per-email rate limits lived in one process's
  memory (acceptable: restart = re-login, no data loss). The chosen
  launch platform is Vercel + Supabase, and serverless breaks that
  premise — every request may hit a fresh instance, so in-memory auth
  state evaporates between the magic-link request and its redemption.
  DECISION: Extract a SessionStore interface (issueLink/redeem/userIdFor,
  all async). The in-memory Sessions class remains for local dev and
  container deploys; PgSessions (packages/backend/src/pg-store.ts) is
  the deploy implementation, adding login_tokens (single-use via a
  conditional mark-used UPDATE — not DELETE, so redeemed links still
  count toward the 3/hour rate limit) and sessions (30d rolling expiry
  via UPDATE ... RETURNING) tables to the auto-created schema. The
  Vercel entry is api/index.ts (hono/vercel-style fetch handler) with
  vercel.json rewriting /auth/*, /me, /mutations/*, /healthz to it and
  serving packages/shell/dist statically — same origin, cookies intact.
  Privacy posture unchanged: the new tables hold opaque ids and expiries
  only. Root package.json gains hono+pg (already backend deps) solely so
  Vercel's function bundler can trace them; the kernel dependency rule
  is untouched. Fly remains a supported alternative (Dockerfile kept).
  CONSEQUENCE: redeploys no longer sign users out on any platform with
  DATABASE_URL set; test/serverless.test.ts simulates fresh instances
  per request over a shared fake pool and pins the SQL semantics.

ADR-032 (2026-08-31) Rollback hides physical shape instead of deleting data
  CONTEXT: inverse operations for a post-version table or column executed
  `DROP TABLE` / `DROP COLUMN`. That contradicted Principle 1 and doc 04 §5:
  rows and edited field values created after a shape change vanished on
  rewind, while the old property test normalized the loss before comparing.
  DECISION: inverse create/add operations mark registry tables or columns as
  kernel-only `inactive` tombstones and leave SQLite bytes in place. The
  public registry, query compiler, writes, Observer, and row history project
  inactive shape away. Roll-forward or a compatible same-name re-add clears
  the tombstone. A returning backfill updates only NULL cells, preserving
  prior values while initializing rows created during the rewind.
  CONSEQUENCE: rollback is information-preserving, truncated history still
  retains recoverable physical values, and incompatible name reuse fails
  rather than overwriting preserved data. Four direct regression tests plus
  PB1 pin table rows, column values, marker-scoped backfill, and truncated re-add.
  Archive format 2 carries the tombstones plus missing-cell markers while
  retaining format-1 import compatibility; old binaries reject format 2.

ADR-033 (2026-08-31) Panel writes require a fixed-runtime gesture grant
  CONTEXT: declared_writes limited table scope but any panel could still call
  insert/update/softDelete during module boot. Preview shadow writes were not
  replayed by Keep, creating divergence, and live boot could mutate records
  without an action. Raw panel error strings could also include row values and
  flow into display or a model repair request.
  DECISION: the trusted vnode renderer emits a protocol-level user_gesture
  immediately before invoking a panel-authored callback from a trusted native
  event. Synthetic `.click()`/dispatch paths cannot refresh the grant. The
  Bridge grants up
  to 8 declared writes for 5 seconds, refreshes the grant after a positive
  shell confirmation, and rejects all background/boot writes. Generated code
  never receives the MessagePort. The Bridge maps runtime errors to a small
  code-based message and discards the untrusted raw string.
  Shadow bridges set `allowWrites: false`; preview remains interactive for
  sorting/filtering but data-entry actions unlock only after Keep.
  CONSEQUENCE: forms, boards, and multi-write workflows continue to work, but
  no record mutation can occur merely because a panel loaded. Integration
  tests boot a hostile writer and then prove the same write succeeds on click.

ADR-034 (2026-08-31) Hosted production is fail-closed
  CONTEXT: a Vercel deploy without DATABASE_URL created an open mutation proxy;
  a missing RESEND_API_KEY returned magic links in API responses. Cookie
  sessions could not be revoked, body caps trusted Content-Length, and quota
  check plus increment could race under serverless concurrency.
  DECISION: Vercel requires model key, Postgres, Resend, and HTTPS APP_ORIGIN
  before any endpoint is enabled. Local dev links require explicit AUTH=dev.
  HTTPS cookies are Secure; POST /auth/logout revokes server state; request
  streams are counted to 64KB; and free quota uses one conditional Postgres
  update. Production CORS is pinned to APP_ORIGIN.
  CONSEQUENCE: partial production configuration returns 503 rather than
  silently weakening auth. Backend tests cover fail-closed config, logout,
  Secure cookies, chunked oversize bodies, and concurrent quota admission.

ADR-035 (2026-08-31) Provenance, trust receipts, and situational lenses are
derived trusted-shell projections
  CONTEXT: Shape Map and Change Contracts made proposed changes legible, but a
  kept change lost its contract in the session feed, panels could not answer
  “why is this here?”, and one app still exposed one fixed panel arrangement.
  DECISION: derive panel provenance from existing panel_blobs plus version_log;
  add no metadata table. Convert a kept Change Contract into a trust receipt
  carrying the exact version, diff, affected views, touched tables, and rewind
  target. Derive four app-local lenses from live panel manifests and persist
  only the selected lens id in browser storage. A lens filters trusted-shell
  visibility and never copies records, changes queries, or creates a version.
  CONSEQUENCE: old apps gain provenance immediately, every kept reshape leaves
  an actionable proof artifact, and users can move between review, focus, and
  update contexts over one permanent substrate. Custom saved filter/layout
  presets remain a later extension.

ADR-036 (2026-08-31) Preview and restore actions bind to current history
  CONTEXT: a kept-preview toast could outlive its original head, and a live
  shape change could land while an older preview remained open.
  DECISION: a PreviewHandle records its base version and refuses Keep after
  any newer shape version. Every rewind entry point uses the current confirmed
  restore path, and receipts for truncated versions are removed from the feed.
  CONSEQUENCE: stale controls cannot silently truncate unrelated history or
  commit a plan against an obsolete app shape. Ordinary row edits remain valid
  during preview because they do not create a shape version.

ADR-037 (2026-08-31) Archive import replaces only the current app namespace
  CONTEXT: the validated import path wiped the whole OPFS pool and reopened
  legacy default files, which could remove sibling apps and restore into the
  wrong app.
  DECISION: after staging and integrity checks pass, close only the current
  app, delete only its namespaced user/system files, and reopen that same app
  id before copying the staged archive.
  CONSEQUENCE: importing a backup intentionally replaces the selected app while
  every sibling app and its records remain untouched.

ADR-038 (2026-09-01) Model connections share one certified reshape contract
  CONTEXT: Clay exposed only Anthropic BYO and an opaque hosted URL, while
  users may already have OpenAI API infrastructure or a local Codex subscription.
  DECISION: keep the MutationPlan validator, shadow preview, Change Contract,
  Keep/Discard, and repair loop provider-independent. Add an OpenAI Responses
  adapter with strict structured output and store:false; retain Anthropic BYO;
  expose explicit Clay hosted and OpenAI backend choices; and add a loopback
  Codex connector that uses the existing CLI login without browser credentials.
  The connector uses ephemeral read-only codex exec on every OS; app-server is
  rejected because it cannot ignore user MCP and tool configuration.
  CONSEQUENCE: providers can change without changing Clay's data or safety
  grammar. OpenAI and Codex credentials stay server-side or in the local Codex
  process, and every route is validated through the same preview pipeline.

ADR-039 (2026-09-01) Semantic identity is private kernel metadata
  CONTEXT: names and version coordinates are not durable identities across
  rename, rollback, truncation, reactivation, fork, and archive import.
  DECISION: assign immutable UUIDv7 table, field, and relationship IDs
  after validation; persist them inside internal registry specs; preserve them
  through inactive tombstones and archives; and strip them from planner, model,
  panel, query, and Bridge projections. The first closed relationship is
  contains(table, field), with computed derived_from edges folded by lifecycle.
  Optional concept IDs require an explicit reviewed marker and are never inferred
  from labels; reviewed references remain typed. Archive format 3 requires a
  complete, integrity-checked semantic registry; formats 1 and 2 backfill once.
  CONSEQUENCE: provenance and future cross-app semantics key by stable identity
  without widening generated-code authority or changing user tables.

ADR-040 (2026-09-01) Saved lenses are versioned projections, not data copies
  CONTEXT: built-in situational lenses could not capture a user's own operating
  mode, and panel names alone could accidentally bind a re-created panel.
  DECISION: store a bounded per-app lens library in trusted settings, use opaque
  saved IDs, capture visible panel incarnations plus bounded placement snapshots,
  and apply them as shell-only projections with no version commit. Filter-state
  restoration remains a later version because the runtime has no trusted channel.
  Field provenance projects semantic events and computed dependencies by stable
  field ID into clickable Shape Map disclosures.
  CONSEQUENCE: users can save/delete contextual workspaces and inspect field
  lineage while records, canonical panel layout, and model context remain unchanged.

ADR-041 (2026-09-01) Trust instrumentation is local aggregate state
  CONTEXT: Clay needed activation and trust evidence without collecting records,
  prompts, names, exact timestamps, identifiers, or free-form event payloads.
  DECISION: validate a closed enum-only event union and reduce it immediately
  into 35 days of integer daily counters plus numeric milestone state in local
  system tables. Omit those tables from archives, forks, model context,
  diagnostics, and every network path. Expose only a user-visible 30-day summary
  with independent disable and erase controls. Lazy-load PanelFrame, Data,
  History, Shape Map, and metrics; enforce entry, closure, workers, WASM,
  sandbox bootstrap, total-runtime, CSS, and artifact-freshness budgets.
  CONSEQUENCE: Clay can improve trust loops privately while boot-critical JS is
  smaller and heavy trusted surfaces load only when needed.

ADR-042 (2026-09-01) Local Codex is a separately authenticated tool-less boundary
  CONTEXT: CORS alone does not stop a hostile page from sending a request to a
  loopback service, and a read-only agent can still inspect local files.
  DECISION: generate a per-launch connector bearer, expose it only through the
  allowed-origin health handshake, require JSON and the bearer for mutations,
  enforce origin, rate, and single-concurrency guards, dynamically disable every
  supported Codex feature under strict config, ignore user config, pass an
  environment allowlist, and terminate the complete OS process group before
  deleting request artifacts. Clay hosted sessions never cross provider boundaries.
  CONSEQUENCE: Local Codex reuses subscription authentication without granting a
  web page, model turn, or stale process ambient authority over Clay credentials.

ADR-043 (2026-09-01) Lazy surfaces fail inside recoverable product boundaries
  CONTEXT: a rejected dynamic import could unmount the whole React root, while
  narrow loading strips made the canvas jump during normal chunk fetches.
  DECISION: contain the canvas and every optional surface in trusted error
  boundaries with reload recovery, preserve panel geometry in Suspense fallbacks,
  and inject real chunk failures in the product gate. Both production entry points
  also share one fail-closed configuration validator.
  CONSEQUENCE: transient asset failure keeps app chrome and recovery visible, and
  production cannot launch with dev auth or incomplete credentials.

ADR-044 (2026-09-02) Connected records are stable references with live projections
  CONTEXT: independent tables forced users to duplicate customer, project, and
  task text. Renames could not safely update that copied meaning.
  DECISION: add one and many relation fields that store row UUIDs, validate active
  targets and optional uniqueness, and project trusted `{id, table, label}` links.
  Lookup and rollup fields remain virtual and live. Text conversion requires a
  version and data fingerprint, keeps the source physical column hidden, exposes a
  typed relation under the original presentation label, and rewrites affected panel
  fields through the existing reversible commit.
  CONSEQUENCE: records connect without duplicated facts; target edits update every
  projection; schema rewind, redo, archive, rename, and semantic IDs remain intact.

ADR-045 (2026-09-02) Daily operations use trusted atomic receipts
  CONTEXT: editing one record at a time and searching one table at a time made
  routine work unnecessarily expensive. Giving generated panels a bulk-write API
  would widen their authority.
  DECISION: keep global search, quick create, multi-select actions, saved query
  views, and bulk mutation in trusted shell surfaces. A batch contains at most 500
  closed insert, update, archive, or restore mutations. The kernel prevalidates the
  complete batch, commits once, stores before and after row snapshots, and returns
  a durable receipt. Saved operational views bind table and field semantic IDs while
  retaining names only as legacy presentation fallbacks. Undo compares the current
  raw row with the after snapshot and
  fails with E_CONFLICT after any later edit. Operational views use bounded,
  revision-aware per-app settings and reference canonical tables and fields. The
  trusted Workbench pages by stable ID in 500-row chunks and reports an explicit
  20,000-row surface limit rather than silently omitting records. Search pages the
  same stable IDs across every table, and any filter or saved-view scope change
  clears bulk selection so hidden records cannot be mutated accidentally.
  CONSEQUENCE: frequent work takes fewer actions without adding SQL, code, or
  multi-row authority to the sandbox Bridge.

ADR-046 (2026-09-02) Automations are local declarative workflows, never agents
  CONTEXT: users need recurring work and reminders, but arbitrary code, hidden
  model calls, ambient timers, or unrestricted network actions would violate the
  product's safety and local-first contracts.
  DECISION: persist a closed automation vocabulary with created, updated,
  match-edge, due-date, daily, weekly, and manual triggers; at most eight typed
  conditions; and at most five set-field, create-record, create-related, or local
  notification actions. Values are literals or copies of declared source fields.
  New and re-enabled rules save disabled, show a simulation against at most 100
  records, then require explicit enablement. Event triggers persist the event-time
  row snapshot; failed attempts retain the cursor and retry with inspectable attempt
  keys. Simulation and execution share one exact 100-record maximum; a larger
  scope fails before mutation. Trigger keys, event cursors, and
  active-match state prevent duplicates. Schema commits and timeline moves that
  would invalidate a stored rule fail atomically and leave both rule and schema
  unchanged. Data
  effects use ADR-045 batches; automation-origin events cannot recursively trigger
  rules. The scheduler runs only while Clay is open. Runs and local notifications
  are inspectable, and stale undo fails closed. Data effects, notifications,
  successful receipts, and match ledgers share one transaction. Definition and
  output byte ceilings prevent a bounded record count from amplifying unbounded
  values.
  CONSEQUENCE: Clay performs useful repeat work without executing user code,
  contacting a model, exposing credentials, or pretending to be a background
  cloud service.

ADR-047 (2026-09-02) File bytes stay local, verified, bounded, and portable
  CONTEXT: receipts, contracts, photos, and rich notes are necessary for real
  operational records. Data URLs in rows would bloat queries and generated panels,
  while external object storage would weaken ownership and offline use.
  DECISION: add rich_text as plain portable text rendered through a safe Markdown
  subset, and attachment fields as arrays of opaque IDs. A kernel-owned user.db
  table named `__clay_attachments` stores sanitized metadata, SHA-256, and BLOB
  bytes; its name is impossible under the user-table grammar. Only trusted shell
  APIs can add, read, remove, or purge files. Limits are 10 MB per file, 20 per
  field, 200 MB active, and 250 MB retained per app; executable and active-content
  formats are rejected and common binary formats must match their signatures.
  Removal retains bytes for 30 days and row restore reactivates them. Archive
  format 4 includes file totals and verifies every digest, signature, size,
  reference, and manifest count before import. Import also rejects unexpected
  SQLite schema objects, validates every reachable migration and panel version,
  reconstructs canonical DDL, verifies the selected version cursor, and installs
  with transactional rollback plus read-back before commit.
  CONSEQUENCE: rich records remain offline, reversible, and portable without
  widening panel authority or hiding file custody behind a service.

ADR-048 (2026-09-04) Exact target identity and protection state are worker-owned and fail closed
  CONTEXT: the shell currently treats `localStorage` as the app registry and
  collapses any OPFS open failure into a writable memory database. A/B require
  truthful protection, non-reusable identity, and no overwrite when durable state
  is unreadable or ambiguous.
  DECISION: add closed shared schemas for the complete target tuple
  `(appInstanceId, activeGenerationId, lineageEpoch, stateRevision,
  stateDigest)`, durable catalog snapshots, storage-open outcomes,
  Temporary eligibility, and device protection state. UInt64 values are canonical
  decimal strings in `0..18446744073709551615`; app/generation IDs use their
  prefix plus exactly 26 lowercase RFC 4648 base32 characters `[a-z2-7]`; state
  digests are `sha256:` plus 64 lowercase hex characters. The DB worker is the only
  authority for catalog selection and identity; `localStorage` becomes a
  discardable presentation cache. Expected, denied, unreadable, locked, corrupt,
  quota, attach, and unclassified storage failures yield `locked_or_unknown` and
  cannot create or seed a memory replacement. `temporary` requires readable
  authoritative inventories proving exactly zero apps, zero durable namespaces,
  and zero pending operations, explicit unsupported or non-persistent capability,
  the displayed loss boundary, and recorded user choice. The same proof without
  choice yields `temporary_choice_required` and creates no app/store. Device
  protection requires evidence matching the catalog-selected complete target.
  Cross-database operations may claim physical atomicity only after a release-bound
  crash/reopen certificate passes for the exact SQLite-WASM/OPFS topology, or a
  separately selected colocation/recovery-journal fallback passes. Until then,
  affected mutation routes remain disabled or read-only/export-only.
  CONSEQUENCE: initial work adds schemas, pure derivation, and tests only. The
  worker does not publish a protection state until catalog authority and
  write-route enforcement land together. Later slices add catalog migration,
  write fencing, checkpoints, backup, and recovery under the same closed contracts.
  CORE EVIDENCE (2026-09-04): `pnpm verify:transaction-core` passed 180/180
  Chromium 149 kill/reopen cases with SQLite source
  `4525003a53a7fc63ca75c59b22c79608659ca12f0131f52c18637f829977f20b`,
  three SAH-pool databases, `delete` journal mode, and failpoints after BEGIN,
  DDL create/insert, main data, system metadata, catalog data, before COMMIT,
  after returned COMMIT, and normal completion. This validates the core attached
  mechanism for continued implementation only. It does not unlock a release
  writer until semantic participants, concurrency, supported runtimes, and the
  native commit/durability boundary satisfy the full certificate.

ADR-049 (2026-09-04) Catalog schema 1 proceeds; raw SQLite-pair target digests are rejected
  CONTEXT: ADR-048 requires a worker-owned catalog, target-bound writes, and a
  digest that identifies canonical state without making ordinary writes depend on
  retained attachment volume. The exact SQLite build exposes neither `sha3` nor
  `sha3_query`. Chromium measurements over 10.75 MiB required 10.3 ms to export,
  49.5 ms for WebCrypto, and 141.3 ms for synchronous SHA-256. Independent probes
  showed equal logical state can have different serialized SQLite bytes after
  reconstruction or physical maintenance. Zeroing a digest stored inside the
  database also failed self-reference reproduction.
  DECISION: select catalog schema 1 with a singleton authority root, retained ID
  registry, live/tombstoned app rows, immutable generation descriptors, leases,
  pending jobs, and non-reusable lineage/revision reservation journals. Opening an
  absent or partial catalog never initializes or repairs it. Initialization is a
  separate operation allowed only after authoritative zero-inventory proof.
  Reject exact database-pair bytes and commit-chain-only hashes as target digest
  schema 1. Schema 1 will be a target-owned canonical logical Merkle map. Stable
  logical leaf keys and type-tagged values commit every archive-visible record and
  schema object. Attachment leaves commit validated content SHA-256, size, type,
  name, lifecycle, and references without rehashing retained bytes on unrelated
  writes. The map uses 1,024 deterministic buckets with the byte framing fixed in
  the data model; ordinary writes recompute only
  changed leaves, affected bucket roots, and the fixed bucket-root vector. Digest
  tables, target headers, and explicitly device-local telemetry are excluded from
  their own root. Full rebuild audit is mandatory at boot, checkpoint, import, and
  restore boundaries. Catalog app publication remains blocked until format 5 and the
  production commit coordinator consume the canonical census and checked root.
  The canonical census and persisted-root comparison are required prerequisites and
  have their own fail-closed kernel tests; they do not by themselves publish or grant
  write authority. Target authority metadata is target-owned but excluded from its
  own logical root. Its strict header stores current/high-water counters and digest
  schema only; evidence combines it with an independently audited Merkle root. A
  reservation is a separate durable, operation-idempotent commit that advances only
  high-water and may leave an abandoned permanent gap. It does not advance current
  state or authorize a writer.
  Canonical no-ops return current evidence without mutation or reservation. A meaningful
  tracer reserves matching target and catalog rows in one physical transaction, then
  commits data, Merkle publication, target current revision, both journal rows, catalog
  head/generation, and full-census read-back in another. Failure rolls the commit back
  and abandons the same consumed revision in both journals. A committed row retains its
  exact state digest, original expected revision/digest, and canonical fingerprint of a private
  cloned change set. Matching operation-id retry of the current commit returns original
  evidence without replaying mutation or allocating another revision; historical replay
  fails closed until an authenticated current-anchored journal chain exists, and
  mismatched reuse fails closed. The coordinator invokes the canonical
  census itself with its trusted registry and checks root plus leaf count, rather than
  accepting a caller-supplied digest attestation. It captures every caller-controlled
  commit field once and verifies the single parsed operation ID in both persisted journals
  before returning success. Trusted indexed traversal reconstructs change fields into
  private fixed-shape records without invoking caller-owned array methods. Object and
  callable-function thenable
  mutation callbacks fail before Merkle publication and their synchronous writes roll back.
  The coordinator opens the
  catalog only through its own guarded driver. Guard ownership and transaction depth are
  held only in a module-private WeakMap for a factory-registered physical driver. An opaque
  owner-bound capability and `sqlite3_set_authorizer` reserve savepoint/transaction opcodes
  for private control. Primitive SQL and cloned supported bind arrays are validated before
  forwarding; options objects, malformed binds, appended trigger transaction control, raw
  writes, a second guard, and authorization inside an existing transaction are rejected.
  Autocommit is verified before authority and after release. Forwarding wrappers cannot
  forge identity. A trusted injected worker clock, not caller journal
  timestamps, checks the final lease before mutation code is invoked.
  Catalog app rows retain an immutable genesis tuple. A contiguous
  `catalog_generation_events` journal records every root-generation advance and binds it
  to app seed, lease, reservation, finalization, or takeover evidence. The app-seed event
  pins the complete immutable genesis target, preventing a coherent descriptor re-anchor.
  Finalization uses
  the exact reserving fence or one expired-owner successor epoch, and lineage changes are
  denied until their own complete journal exists. A successor-epoch finalization must be
  `recovery_takeover`; ordinary commit and abandonment must remain on the reserving epoch.
  Exact committed replay is read-only but still requires catalog generation/fence and
  matching evidence in both journals; target-only committed evidence fails closed.
  After an expired reserved owner,
  one same-driver recovery transaction advances epoch/generation, creates a new lease,
  and abandons both mirrored rows; the next revision remains usable while the gap stays
  permanent. This coordinator remains non-exported and cannot authorize production
  until worker serialization, every write route, and archive format 5 join the boundary.
  Authority-only runtime schemas live at `@clay/schema/catalog`; the boot-reachable main
  schema entry does not initialize unexported catalog/coordinator contracts.
  Target evidence is mandatory in a new archive format. Existing format 4 remains
  importable legacy input but cannot itself certify a target. A live driver rejects
  every SQL write outside one synchronous coordinator transaction. Independent
  previews remain writable because they cannot alter live state or catalog authority.
  Async WebCrypto may not hold authority until one non-reentrant executor is proven
  to serialize worker commands, every Store RPC port, lifecycle work, and internal
  jobs with crash-safe teardown.
  CONSEQUENCE: strict catalog, inventory, lease, and ambient-write-denial primitives
  may land, but target publication, legacy migration, protection publication, and
  every production writer remain unchanged and uncertified until the Merkle format,
  real-OPFS catalog-first integration, complete route fencing, reservation semantics,
  concurrency, archive-format gate, performance matrix, and release-bound crash/reopen
  evidence pass.
  IMPLEMENTATION UPDATE (2026-09-06): Production authority now uses a separate frozen
  guarded driver and opaque write opener. Mirrored request receipts persist
  `prepared|invoked|committed|no_op|failed`; live mutation begins only after durable
  `invoked`, ambiguous invocation never re-enters, and no-op completes from a revalidated
  shadow. Poison is rechecked when every queued mutation or operational metric begins,
  before receipts, reservations, or Store calls. Before every target census, trusted boot
  deletes the shared legacy credential-key set without selecting values; unmigrated DB-only
  credentials require deliberate re-entry. Catalog-first boot adopts a declared
  multi-legacy manifest, replaces shell app
  caches from a detached catalog projection, and publishes app selection/metadata events.
  A real Chromium 149 OPFS worker gate has passed multi-namespace declaration, interruption
  after one atomic adoption, fresh-worker resume, and canonical switching, but remains a
  slice-only `releaseCertificate: false` report. CRUD, settings, structural layout, and
  starter seeding are authority-routed. Remaining lifecycle, preview, automation, import,
  attachment, undo, restore, and archive routes remain fail-closed and therefore block
  protection publication and release certification.

ADR-051 (2026-09-06) Model I/O lives in a per-intent trusted-shell planner bridge
  CONTEXT: the DB worker must retain the complete MutationPipeline, validation,
  shadow preview, pending command, Keep/Discard, and SQLite authority, but importing
  MutationClient also pulled provider fetch code, credentials, and the prompt corpus
  into its measured closure beyond the fixed worker budget. Moving validation or
  preview authority out of the worker would weaken the existing safety boundary.
  DECISION: each intent or panel repair transfers one fresh MessageChannel to the DB
  worker. The worker mints a per-boot epoch, a monotonic per-intent generation, and an
  opaque context identity; captures one immutable S1 snapshot; and requests attempt 0
  plus at most one pipeline-authorized repair attempt 1. Every closed request,
  response, cancellation, and finalization acknowledgement binds epoch, generation,
  context, attempt where applicable, and sequence. Raw output and diagnostics are bounded. Provider response bodies are consumed as
 streams with a 2 MiB success ceiling and a 64 KiB error ceiling; health responses
 have a separate 16 KiB ceiling. Provider fetch plus body consumption has a hard
 180-second deadline, while each worker-side planner round and finalization wait has
 an independent 180-second watchdog. Before publishing a preview, the worker requires a finalization
  acknowledgement FIFO-ordered after earlier shell terminal traffic. Malformed,
  duplicate, late, cancelled, out-of-order, wrong-attempt, or stale-boot traffic fails
  closed. Any planner request or repair rejection after `beginAttempt` durably
  finalizes that attempt as failed before propagating the original error. The trusted
  shell lazily imports MutationClient and holds the
  selected provider access only in ECMAScript-private memory. Model-access publication
  uses descriptor-only exact capture plus separate preparation and publication generations.
  Starting a replacement synchronously cancels older planners and closes planner admission;
  only the latest resolved snapshot reopens admission. Late raw output becomes inert, and a
  late preview is durably discarded before its caller is rejected. Intent text, planner
  context, repair inputs, successful bodies, and diagnostics are rejected before model
  invocation or worker publication when they semantically contain active credential
  material. A monotone fixed-point scan checks every recursively escaped JSON view and
  rejects fail-closed after 16 MiB of normalization work.
  Credentials and health fetching never enter DB-worker messages or source. The shell
  bridge receives only the existing
  schema/panel/summary/intent context, never rows, and returns opaque raw text or a
  bounded provider error. The DB worker alone decodes, validates, dry-runs, and creates
  a preview; model output cannot Keep or mutate live state. Finalization uses a worker-
  minted one-use nonce, and clarification is not durably recorded until that nonce is
  acknowledged.
  CONSEQUENCE: provider, hosted, BYO, and local Codex behavior remains available while
  the DB-worker closure excludes model-client/prompt code. Boot keeps a candidate authority
  unreachable until interrupted-attempt reconciliation succeeds and one transaction proves
  its physical target matches the selected catalog target. Concurrent or duplicate boot
  calls share that candidate; failure closes it and leaves no Store or mutation authority.
  Graceful shutdown closes top-level admission synchronously, asks every Store client to
  echo a one-use FIFO quiescence challenge only after its admitted responses settle,
  closes Store admission, waits for all admitted responses, durably discards an open
  preview, closes Store ports and production authority, and only then acknowledges.
  Ambient cookies default denied and require an explicit per-origin verified grant; backend
  switches preserve every other origin's decision. A magic-link request persists a random,
  expiring, one-use state bound to Clay and the exact backend. An email click carries token
  and state in a fragment without redemption or cookie creation; only a matching app landing
  redeems with `credentials: "omit"` and publishes the returned bearer. Superseded callbacks
  revoke only their returned bearer with cookies omitted. Every granted, revoked, provider,
  key, or backend transition publishes an origin-bound storage generation; other tabs
  synchronously cancel planners and revoke worker access before reloading device-global
  access. Local sign-out clears bearer and origin grant, revokes worker access, publishes
  revocation, and only then attempts bounded cookie-inclusive remote logout.
  The client treats rejection or a 2.5-second timeout as failure, hard-terminates as a
  fallback, and reports that failure to its caller. Disposable shadow cleanup cannot
  reopen or mask a durable Keep or Discard. The remaining Keep/Discard protocol and
  complete-browser accounting remain unchanged.

ADR-050 (2026-09-08) Read-only shares are immutable client-encrypted export snapshots
  CONTEXT: external recipients need approved results without an account, while the
  relay must never acquire local-database read authority, plaintext records, file
  authority, decryption keys, or canonical-write authority. Field, predicate, and
  attachment scope changes must not reuse stale approval.
  DECISION: add closed F1 schemas on a separate `@clay/schema/share` entry. A
  trusted projection request pins table, fields, record or view predicate, and
  schema version by stable ID. Approval binds that request, an ordered mapping of
  stable field IDs to projected outputs, and each separately selected attachment
  to its stable file ID, source table/field/record IDs, byte size, and SHA-256
  digest, plus the SHA-256 digest of the exact canonical preview. Attachment
  inclusion is allowed only for an exact single-record projection. Creation
  revalidates the current projection and the file's membership in that current
  visible record attachment field before reading bytes. Any scope, membership,
  metadata, or preview digest change requires approval again. The browser
  verifies file bytes against the approved size and digest, builds the closed
  payload, and encrypts it with AES-256-GCM; authenticated data binds the
  opaque share ID and expiry. The viewer key exists only in the URL fragment.
  The hosted service accepts only a bounded strict ciphertext envelope, expiry,
  owner identity, and a hash of a separate revocation capability. Authenticated
  owners may create at most 100 retained links or 64 MiB per 30-day lifetime;
  Postgres serializes quota checks with a transaction-scoped per-owner advisory
  lock. Public reads omit credentials, return no-store ciphertext, and cease at
  expiry or revocation. Links are immutable snapshots; there is no live database
  query or relay-to-kernel write path.
  CONSEQUENCE: recipients get an account-free static view and explicitly approved
  files, while tests can prove hidden fields, stale same-count previews, and
  unapproved file bytes never cross the export boundary. Revocation prevents all
  subsequent relay reads, and expired ciphertext is reclaimable.

ADR-052 (2026-09-08) Local-export network evidence closes over user actions.
  CONTEXT: Release F's zero-network count stopped after preview and treated every
  same-origin request as expected. CSV or Print could therefore issue HTTP, beacon,
  image, form, or WebSocket traffic after the recorded interval while the report
  still claimed local-only execution. Blob-backed downloads also had no separate,
  durable classification in the strict evidence schema. The actual maximum Print
  PDF was checked only in a temporary harness directory and then deleted.
  DECISION: extend the unshipped LocalExportEvidenceManifestV2 network observation
  with exact current-view and record action tuples, zero WebSocket counts, and
  exact created/downloaded blob-URL counts. The browser certificate now brackets
  preview through observed CSV and Print completion, rejects every request or
  socket regardless of origin, and accepts download URLs only when they match an
  object URL created inside that interval. BenchmarkEvidenceManifestV1 also binds
  maximum-print.pdf metadata, extracted-text digest, exactness, cell/task bounds,
  and responsiveness; the outer release inventory retains and rehashes that PDF.
  ALTERNATIVES: continue relying on the global expected-origin guard (rejected: it
  proves origin containment, not zero egress); infer action coverage from output
  files (rejected: files do not bind the request interval or Print invocation).
  CONSEQUENCE: older draft V2 reports fail closed until regenerated. No released
  evidence format is migrated; release ingestion gains durable proof of action
  coverage, intentionally local blob transport, and actual maximum Print output.

ADR-053 (2026-09-08) Public intake is a ciphertext delivery boundary with local commit authority
  CONTEXT: Release F adds public forms and secure file requests without turning the
  hosted service into a record store or giving a relay canonical-write authority.
  DECISION: freeze strict version-1 schemas at `@clay/schema/intake`. Public forms
  expose only stable target/field IDs, bounded presentation metadata, a submit-only
  capability, and an ECDH P-256 public key. Each submission is encrypted in the
  submitter's browser with ephemeral ECDH, HKDF-SHA-256, and AES-256-GCM. The relay
  accepts only a closed ciphertext envelope plus bounded delivery identifiers and
  timestamps, hashes owner/submit capabilities at rest, caps item/count/retention,
  and never receives the owner private key or decrypted field/file content.
  Decrypted submissions remain untrusted local inbox items. The local kernel resolves
  stable IDs against the exact form schema version, validates scalar values and every
  file's size, type, signature, active-content markers, and SHA-256, and keeps bytes
  quarantined until an explicit acceptance. Manual acceptance is the default. An
  auto-accept rule is a separately enabled finite equals/is-present predicate over
  allowlisted scalar fields, requires a deterministic local simulation fingerprint,
  cannot accept forms containing file requests, and is rechecked at commit. Accepted
  rows and reviewed files activate in one trusted transaction with a conflict-checked,
  undoable receipt; undo deactivates both the row and activated file bytes.
  CONSEQUENCE: public users need no Clay account and the hosted operator cannot read
  submissions. Form/schema changes intentionally stale old acceptance authority and
  require re-authoring/republication rather than silently widening scope.
ADR-054 (2026-09-06) Daily Home begins as a local read-time projection over explicit bindings
  CONTEXT: Release D needs one ordinary returning-user home, but canonical work already
  belongs to typed user tables and automation notices already belong to
  `sys.notifications`. Copying either source into a second work queue would create stale
  authority. Due-field guessing, loaded-page totals, host-timezone arithmetic, and a Push
  prompt during first use would also make a polished surface materially untrustworthy.
  The B3/B4 recovery-source contract and C2 entry descriptor contract are not yet stable
  enough to substitute guessed routes or entry defaults. ADR-048 and ADR-049 certify a
  mechanism and authority design, but the current browser report is not a release-bound
  physical transaction certificate for every state-changing D path.
  DECISION: Today and Inbox are fresh, bounded, model-free read projections. A table may
  contribute due work only through one reviewed profile containing explicit stable field
  identities for its label, due value, and optional completion rule. Bindings are never
  inferred from labels or field order. Projection pages use closed exact or partial
  completeness, source-native monotonic generations, source status and watermarks, a
  deterministic ranking tuple, and cursors bound to the complete snapshot basis and next
  time-only invalidation boundary. There is no copied Inbox or Today item table.
  The basis begins with the selected app and active generation and includes the canonical
  ready/issue profile-resolution partition. All canonical ordering is ordinal and
  byte-stable, never locale-sensitive. The cursor is a closed canonical envelope over all
  adapter continuations and page scope with a domain-separated integrity checksum; its
  verifier rejects malformed, cross-basis, cross-scope, and expired values.
  The exported Zod snapshot contract validates shape only. A trusted kernel builder captures
  plain data without invoking accessors, derives aggregate completeness and the SHA-256 basis
  digest, cross-checks section occurrences against source occurrences, and deep-freezes the
  accepted result. Shape parsing alone never establishes a trusted projection.
  Cross-source seen, snooze, and dismissal will use the app-owned
  `sys.inbox_dispositions` table with integer compare-and-set revisions, but that table and
  all related writers remain gated until physical transaction and archive integration pass.
  App-owned Daily Home configuration and dispositions belong in archive format 5; device
  capabilities, subscription credentials, and remote route maps do not.
  Calendar behavior will use one injected-clock utility based on
  `Intl.DateTimeFormat.formatToParts`, explicit UTC arithmetic, and recognized IANA zone
  identifiers, with no new runtime dependency. Selection stores the runtime-preferred
  identifier once. Readers preserve and accept any still-recognized stored IANA link rather
  than re-canonicalizing it, so an ICU alias rename cannot brick an archive or silently
  change a snapshot digest. Unsupported zones fail closed. Accepted stored date values
  share the exact row-storage grammar and normalize missing seconds or one-to-three
  fractional digits before projection. Nonexistent wall times advance to the first valid
  instant after the gap; repeated wall times resolve once at the earlier offset and expose
  that deterministic result in the snapshot basis.
  Fixed-offset identifiers such as `+05:30` and `-04` are not IANA zone identifiers and
  are rejected even on runtimes whose `Intl` implementation accepts them; recognized IANA
  links such as `US/Eastern` and `Asia/Katmandu` remain valid stored values.
  The local Inbox is independent of off-device delivery. Off-device reminder delivery
  remains deferred until a separate protocol, custody, abuse, revocation, support-matrix,
  and per-cell outcome decision is accepted. Read-only D1 projection work may proceed,
  but every state-changing D route remains fail-closed until its B/C contracts, exact
  worker-owned request path, archive lifecycle, and release-bound physical transaction
  certificate pass. D5 also remains blocked on E3 runtime clarity.
  Recovery remains a source-status slot only until B3/B4 defines a stable incident identity;
  D0 exposes no guessed recovery item or route. D1 item actions are limited to Open and
  Setup/Fix navigation and reuse canonical UUID row IDs, automation IDs, saved-view IDs,
  and semantic table IDs. They cannot express Complete, Snooze, or Dismiss.
  CONSEQUENCE: D0 may add strict projection schemas, deterministic calendar/ranking code,
  bounded read adapters, and an Experimental Today surface. It may not describe Complete,
  Capture, Snooze, Dismiss, reminders, or recurrence as available merely because the
  read projection exists. Exact totals and caught-up copy are forbidden under any partial
  source state, and no user-study promotion requirement is waived by this decision.

ADR-055 (2026-09-12) Development reconciliation of lifecycle archives and secret custody.
  CONTEXT: The worker-owned multi-app catalog now retains terminal lifecycle receipts.
  Format-5 collection must not drop those physical rows. Backup Trust key material
  must remain outside the DB worker, even though app snapshots, identity, and backup
  publication are owned by ProductionStoreAuthority.
  DECISION: Keep the format-5 archive and COSE authentication envelope unchanged.
  Catalog evidence schema 2 extends schema 1 with bounded lifecycle receipts and
  their exact physical generation/namespace bindings. Schema 1 stays readable.
  Unknown versions, incomplete physical row coverage, and nonterminal lifecycle
  jobs fail closed. Receipts are validated against catalog events, metadata, and
  target history; they are evidence, not authority to replace a local namespace.
  Backup Trust uses its existing IndexedDB vault in the trusted shell. It is not
  an app-data authority and cannot mint an app identity or choose physical storage.
  Recovery Kit bytes and keys never enter the DB worker, provider, or panel. The
  shell authenticates archive envelopes over a dedicated, single-use MessagePort
  attached only to the corresponding worker request. The worker waits for that
  channel, checks its request/digest binding, then validates the format-5 payload
  in isolated memory. Checksums or caller-supplied authentication booleans alone
  cannot authorize parsing or publication. Publication additionally requires a
  retained authenticated stage, or an exact already-published catalog artifact,
  and the current production catalog fence. Restore-as-new remains closed until
  fresh destination reservation, installation, publication, and crash recovery
  are reconciled with the lifecycle journal. No replace-current fallback exists.
  During the explicitly authorized development-first mission, source-backed
  conversion and Daily Home actions may be enabled for development finder loops.
  This does not waive the frozen budgets, physical certification, final integrated
  test campaign, independent review, or human accessibility requirements for release.
  Text conversion previews bind a SHA-256 fingerprint to semantic identities and
  the authority target, scan at most 5,000 source and 5,000 target rows, and execute
  a disposable shadow conversion before Keep. Original text and physical values
  remain available to the inverse migration. Daily Home configuration, navigation,
  timezone, and Capture/Undo receipts use the guarded production mutation journal.
  CONSEQUENCE: Legacy secret-bearing DB commands are documented as retired, not
  re-enabled. Read-only OPFS status still means only Protected on this device.
  Development checkpoints are not shipping claims or regenerated review evidence.

ADR-056 (2026-09-12) Source-bound restore jobs and exact copied-target receipts.
  CONTEXT: ADR-055's restore prerequisite needs a worker-owned lifecycle, not the
  old key-bearing coordinator or a direct replacement Store import. A copied
  starter also cannot keep another authority's sample-producer attestation.
  DECISION: The private verifier authenticates before ZIP parsing. A bounded
  in-memory worker grant binds the verified payload to the exact selected source,
  authority incarnation and catalog generation. Only lease-only suffixes may
  precede Keep. The worker reserves a fresh destination and persists a closed
  version-2 restore job containing non-secret request, grant, source and fence
  evidence before creating any target file. Installation and publication must
  reject a pre-existing destination footprint before declaring it job-owned and
  retain that exact install claim. A terminal lifecycle receipt binds the result;
  a lost response replays that receipt, never creates another app.
  Boot recovery runs before strict inventory classification. Under physical
  lifecycle exclusion it acquires a fresh fence, atomically claims the pending
  job for cleanup, validates only exact job-explained files/sidecars, and proves
  the selected survivor readable. Each unlink rechecks the claim. Publication
  and cleanup cannot both win. Partial create/unlink is recoverable; committed
  targets and source files are never catch-deleted. A cleaned-up invocation gets
  an exact terminal not-published receipt; a fresh validation is needed to retry.
  Restore/fork of samples adds one internal producer re-attestation in the fresh
  install transaction. The receipt records both initial publication and the final
  target; catalog/archive readers require the exact reservation/commit suffix.
  Data, panels, prior history and sample coordinates remain intact. Generic
  mutation dispatch cannot invoke these internal producer routes.
  Manual format-5 download records are bounded app-owned journaled metadata,
  require authenticated readback, and always mean unverified external save.
  Starting a download cannot update verified-backup status. Trusted-shell backup
  preparation/publication/retirement uses cross-tab exclusion plus vault CAS.
  A lease-only refresh retains candidate bytes/identity; a staged or published
  retry re-reads the existing file. A folder/source change reconciles the exact
  catalog publication before retiring its candidate and never deletes a file.
  CONSEQUENCE: This enables the source restore journey during development without
  changing format-5 authentication or authorizing replacement. Legacy format-1
  pending jobs remain readable for fenced cleanup only. Keys and Kit bytes stay
  outside the DB worker. Manual-download reload recovery, external partial-file
  recovery/retention completion and the integrated certification gates remain
  required; none is implied by these source changes or focused tests.
