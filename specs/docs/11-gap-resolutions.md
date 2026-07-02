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

## G18 Clarify-plan field values (CORRECTION to doc 05 §2)
Doc 05 says a clarifying plan has "ALL other fields null", but the Zod
schema requires non-null fields and exemplar 7 uses ""/[]/0.3 — the three
disagreed (OPEN-QUESTIONS Q1). DECISION: exemplar 7 is authoritative. A
clarifying plan has migration null; panels, remove_panels, assumptions and
user_facing_diff EMPTY; summary EMPTY STRING; confidence still reported.
Schema change: summary min-length applies only when clarifying_question is
null (moved into the superRefine). Doc 05's "ALL other fields null" reads
as "empty/null" from here on.

## G19 Exemplar set vs doc 05 §3(5) coverage list (Q2)
Exemplar 3 (03-computed-and-strip.md) contained a within_days date-alert,
not the computed column its filename, doc 05's list, regression intent 9,
and doc 03 §7 all point at. DECISION: exemplar 3 is REWRITTEN to the
health-score computed+strip (Context B) — it now creates the
projects.health_score column that doc 03 §7's canonical worked example
queries. The within_days / date-alert / empty-state / top-strip teachings
it carried are fully duplicated by exemplar 10; G7's "exemplar 3 exercises
it" now reads exemplar 10; the vaccine scenario itself remains regression
intent 3. Two further list corrections: doc 05's "remove panel" is covered
as a removal INTENT by exemplar 9 (hide field, honest summary) — the
remove_panels surface is a trivial string array exercised by regression
intent 18 and named in hard rule 1; "low-confidence assumption" reads
"partially out-of-scope intent" (exemplar 10) — assumption-recording is
exercised across exemplars 1, 2, 5 and 10.

## G20 compute.eval is sync, therefore in-iframe (Q3)
Doc 03 declares clay.compute.eval sync; the draft Bridge schema listed
"compute.eval" as a (necessarily async) postMessage call. DECISION: the
ExpressionEngine is a dependency-free shared module compiled into BOTH the
kernel and the PanelRuntime bootstrap; all of clay.compute (eval, now,
daysBetween, formatCurrency) runs in-iframe and synchronously, exactly as
doc 03 reads. "compute.eval" is removed from BridgeCall. now() inside the
iframe returns the kernel timestamp delivered with the last bridge message
(monotonic enough for display; doc 03 already shims Date). Consequence:
bootstrap grows a few KB; expression semantics cannot drift because both
sides build from one module.

## G21 Boot payload contents (Q4)
Doc 06 §3's boot message named a `tokens` field the schema lacked, and
nothing said how clay.meta gets its data. DECISION: boot carries
{v, kind:"boot", code, panelId, apiVersion, meta, tokens} where
meta = {schema: registry snapshot, appVersion, placement} (backs clay.meta
verbatim) and tokens = the design-token map the kernel stylesheet exposes
(read-only theming; panels never see raw CSS). A boot-time snapshot
suffices because every commit hot-swaps panel iframes (doc 02 §5).

## G22 Write access is declared, like reads (Q5; promoted to ADR-014)
Exemplar 5 inserts into `appointments` while declaring only a `clients`
query; doc 03 scopes declared_queries to reads while doc 06 §3 said "table
access checked against declared_queries" for every call. DECISION:
PanelArtifact gains `declared_writes: string[]` (table names, <= 4). The
Bridge checks reads structurally against declared_queries (V4) and
insert/update/softDelete against declared_writes. V4 additionally requires
the table argument of every write call in panel code to be a string
literal present in declared_writes. Exemplar 5 updated; least privilege
per the doc 06 threat model.

## G23 Backfill invertibility and the I2 mirror (Q6)
Exemplar 2 has two forward ops but one inverse, and no InverseOp can
restore values a backfill overwrote on a pre-existing column. DECISION:
(a) Zod enforces exactly one of value|expr on backfill (doc 04 wrote
"value | expr"); (b) I2's op-by-op mirror runs on a NORMALIZED op list:
backfill and add_index targeting a column CREATED IN THE SAME PLAN are
absorbed into that column's create/drop pair — exemplar 2 is the canonical
shape; (c) V5 REJECTS backfill targeting a pre-existing column in v1
(not invertible inside the vocabulary; Principle 2 outranks convenience —
the validator-rejection log will tell us if this matters).
set_required.default_for_existing fills NULLs only; the inverse restores
the requirement bit, and the filled rows are recorded to row_history (G6).
Documented partial invertibility, accepted.

## G24 V7 diff-honesty mapping (Q7)
Read literally, V7 fails exemplar 2 (backfill has no diff line).
DECISION: two op kinds need no line of their own — backfill (covered by
the add_field/add_status line of the column it fills) and add_index
(user-invisible). Every other forward op maps 1:1 to a diff line of
matching kind; the mapping table ships as Validator fixtures (V7).

## G25 Component contracts the exemplars already use (Q8)
Doc 03 never defined FieldSpec, FilterBar's option lists, or the
threshold badge maps its own §7 example uses. DECISION, canonicalized
from the exemplars: FieldSpec = {name, label?, kind: "text"|"number"|
"date"|"select"|"checkbox", options?: {value,label}[], fromSchema?:
"table.column", required?} — kind and required default from the registry;
fromSchema binds a select's options to a registry enum so forms survive
enum additions (exemplar 5). FilterBar select filters accept the same
options list (exemplar 6). Badge maps over NUMBER fields accept threshold
keys "<N" "<=N" ">N" ">=N", evaluated in declaration order, first match
wins (doc 03 §7, exemplar 3).

## G26 Housekeeping batch (Q9, Q11–Q13)
- BridgeCall gains "events.off"; events.on returns an Unsubscribe that
  sends it (doc 03 already promised this).
- The prompt file is specs/prompt/system-v1.md; doc 05 §3's "prompt/v1.md"
  reads accordingly.
- schema package uses a recursive JsonValue type; z.any() is banned there
  (CLAUDE.md TypeScript rule).
- MigrationEngine quotes EVERY identifier in emitted SQL; identifiers are
  already Ident-validated, so shell column `on` (a SQLite keyword) is legal.
- Package moved to the doc 02 §9 target layout: specs/ holds this package,
  packages/schema/ holds the constitution (P0.3 freeze happens there).
- ADR-013, referenced by G1 but missing from doc 10, is back-filled.
