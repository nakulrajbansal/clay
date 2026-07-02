# 11 — Gap Review and Resolutions (pre-code audit)

A systematic pass over docs 01–10 for unspecified behavior. Each gap gets a
binding decision (promoted to ADR where architectural).

## G1 Structured output mechanics (CORRECTION to doc 05 §3)
The Anthropic API's structured outputs are now GA via `output_config.format`
= {type: "json_schema", schema} (the old `output_format` + beta header path
is deprecated-but-working). Critically, the API enforces schema COMPLEXITY
LIMITS (grammar compilation caps on properties, nesting, unions). The full
MutationPlan schema with nested Query/Condition/vnode constraints is too
rich to push entirely into the grammar.
DECISION (ADR-013): two-layer validation. API-level schema = a SIMPLIFIED
MutationPlan (top-level shape, enums, panels[].code as plain string,
migration ops as loosely-typed objects). Full semantic validation happens
client-side via the shared Zod schema (which remains the constitution).
The grammar guarantees parseability; Zod + Validator guarantee correctness.
Keep the API schema stable to benefit from grammar caching.

## G2 Model selection
Default model: claude-sonnet-4-6 (structured outputs GA). Repair rounds and
low-confidence retries MAY escalate to an Opus-class model behind config
flag MODEL_REPAIR. Model ids live in config, never inline. Verify current
ids against https://platform.claude.com/docs at build time.

## G3 BYO-key CORS
Direct browser calls require the `anthropic-dangerous-direct-browser-access:
true` header; settings UX must display the exact tradeoff ("your key is
stored in this browser and sent only to Anthropic"). Confirm header name
against current docs during week 2.

## G4 Multiple apps per user
Previously unspecified. DECISION: v1 supports up to 3 apps. Each app =
its own OPFS subdirectory (/clay/apps/{app_id}/user.db+system.db). App
switcher in the header. Quota is per-account, not per-app. Export/import is
per-app. Rationale: "one app forever" tests badly (people want work +
personal separation); >3 invites tool-sprawl that contradicts the thesis.

## G5 Manual layout edits
Dragging panels to rearrange must NOT cost a model call. DECISION: layout
edits are kernel-local commits (kind: "layout") in the version log with
trivial inverses. They appear on the slider like any change. The model is
for semantics; geometry is direct manipulation.

## G6 Row-level mistakes (data undo)
The version log covers schema/UI, not row edits; soft delete covers
deletions, but bad edits were unspecified. DECISION: user.db keeps a
row_history table (table, row_id, at, before_json) written by the kernel on
every update/softDelete, ring-capped at 10k entries. Data view exposes
"Restore" per row (last 30 days). This is NOT on the slider (row edits are
data, not app-shape) — the separation keeps both mental models clean.

## G7 Dates and timezones
All dates stored as ISO-8601 UTC. clay.compute.now() returns UTC;
within_days/older_than_days compare in the USER'S LOCAL timezone (kernel
converts) because "expiring within 30 days" is a human question. DatePicker
displays local. Documented in the API doc; exemplar 3 exercises it.

## G8 Data edits while a preview is open
Shadow is a snapshot; user may add rows mid-preview. DECISION: previews
render against the snapshot; on Keep, the migration applies to the LIVE db
(safe: migrations are shape-level; backfills recompute over live rows).
A notice appears on the diff card if live writes occurred during preview:
"3 records were added while previewing; they'll be included."

## G9 First run must not require the model
Starter shells are static seed definitions (shells/starter-shells.json):
registry entries + seed panels (hand-written, validator-passing) + 3 sample
rows flagged sample=true with a one-click "remove samples" (kernel-local
commit). US-01's 60-second promise therefore holds with zero network.

## G10 Quota exhaustion UX
At 0 remaining: conversation input stays enabled; submit shows an inline
card with three paths — wait (renewal date), upgrade, or switch to BYO key.
Never a dead end; never a modal.

## G11 Panel identity and naming collisions
panel_id must match ^[a-z][a-z0-9_]{2,40}$ and be unique among live panels;
the model receives the live id list; Validator rejects collisions unless
the plan marks replace: true implicitly by reusing an id (reuse = replace
by definition, per ADR-008). Titles are free text <= 60 chars, deduped with
a numeral suffix by the shell if needed.

## G12 Accessibility floor
Kernel components ship with: full keyboard operability, focus rings,
aria labels derived from props, WCAG AA contrast in both themes, and
prefers-reduced-motion respected (slider scrub becomes stepped). Because
panels can only use kernel components, generated UI inherits the floor —
one of the quiet payoffs of ADR-004. Tested via axe-core in Playwright.

## G13 Telemetry
Client beacons are OPT-IN (settings, default off), send only: attempt
outcomes, error codes, validator rejection reasons, latency. Never intent
text. The doc 09 post-launch metrics degrade gracefully if most users
decline (hosted-mode server metrics still cover commit rates).

## G14 The .clay archive vs. multiple apps
Archive gains app_id + app name in manifest; import offers "restore as new
app" (default) or "replace app X" (destructive, typed-name confirmation —
the ONLY typed-confirmation destructive action in the product).

## G15 Prompt injection via imported archives
An imported system.db could carry hostile panel code predating validation.
DECISION: import re-runs the Validator over every live panel blob; failures
import as disabled panels with a boundary card. Never execute unvalidated
blobs, regardless of provenance.

## G16 Panel code seeing stale schema after rename (I4 edge)
The rename-map applies within the committing plan only. Panels NOT touched
by the plan whose declared_queries reference a renamed column: the kernel
rewrites their declared_queries and stored blobs' query literals via the
map at commit time (mechanical string-safe rewrite on the parsed query
objects, then blob re-render is unnecessary since code introspects via
declared queries at the Bridge). Exemplar 8 exercises this.

## G17 i18n / mobile / offline mutation queueing
Explicitly out of scope v1 (recorded to pre-decide the "no"). Offline USE
works; offline MUTATION shows "reshaping needs a connection" inline.
