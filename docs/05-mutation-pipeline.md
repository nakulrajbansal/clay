# 05 — Mutation Pipeline and Model Interface

## 1. Stages (authoritative)

S0 intake: intent text (<= 500 chars), attempt row created.
S1 context assembly (local): registry + panel manifest (ids, placements,
   declared queries; code only for panels the intent names or that the
   kernel heuristically flags as targets) + last 5 commit summaries +
   intent. NEVER row data. Typical size < 6k tokens.
S2 plan generation (model): structured output, MutationPlan schema below.
S3 static validation (local): doc 06 §5. Fail -> S2' repair (once).
S4 shadow dry-run (local): backup -> migrate shadow -> boot panels bound to
   shadow -> smoke render 2s. Fail -> S2' repair (once, with error).
S5 preview: proposed panels in place (dashed border) + diff card.
S6 keep -> atomic commit (doc 04 §4-5) | discard -> cleanup, record.

Repair budget: ONE model round total per attempt, whether triggered at S3 or
S4. Second failure -> amber failure card. Rationale: bounded cost, bounded
latency, visible honesty.

## 2. MutationPlan JSON schema (Zod, shared package)

```ts
MutationPlan = {
  api: 1,
  summary: string,                        // <= 200 chars, plain English
  user_facing_diff: DiffLine[],           // typed lines for the card
  clarifying_question: string | null,     // if set, ALL other fields null
  assumptions: string[],                  // what the model chose when vague
  migration: MigrationPlan | null,        // doc 04 §4 vocabulary
  panels: PanelArtifact[],                // new or fully-replacing bodies
  remove_panels: string[],                // -> tombstones
  confidence: number,                     // 0..1 self-estimate
}
PanelArtifact = {
  panel_id: string,                       // snake_case, stable across edits
  title: string,
  placement: {region: "top"|"main"|"side", order: number},
  code: string,                           // ES module, default export(clay)
  declared_queries: Query[],              // every query/watch shape used
}
DiffLine = {kind: "add_field"|"change_field"|"add_panel"|"change_panel"|
            "remove_panel"|"add_status"|"add_computed"|"add_chart",
            detail: string}
```

Contract rules the model is instructed on and the validator enforces:
R1 clarifying_question XOR plan (never both).
R2 panels are whole-file replacements (no patches) — simplifies validation,
   versioning, and repair.
R3 every db call shape appears in declared_queries.
R4 migration only when schema must change; pure-UI mutations set it null.
R5 confidence < 0.5 => must use clarifying_question instead.

## 3. Prompt architecture

SYSTEM (static, versioned in repo as prompt/v1.md):
 1. Role: "You write MutationPlans for Clay..."
 2. The ClayAPI reference (doc 03, verbatim, it doubles as model docs).
 3. Migration vocabulary + invariants (doc 04 §4).
 4. Vnode vocabulary + component contracts.
 5. Ten few-shot exemplars (intent -> full MutationPlan), covering:
    add field / add enum status / computed column / chart panel /
    form panel / filter bar + cross-panel event / rename / remove panel /
    ambiguous intent -> clarifying question / low-confidence assumption.
    Exemplars are HAND-WRITTEN FIRST (pre-code task P0, doc 09) — they are
    the real spec of "good output."
 6. Hard rules: no destructive ops; inverses mandatory; introspect
    clay.meta.schema in code rather than hardcoding columns when reasonable;
    one clarifying question max; write summaries a non-technical person
    understands; never mention code or SQL in user-facing text.

USER (dynamic): the S1 context as structured sections, then the intent.

REPAIR turn appends: validator errors or runtime stack (sanitized), the
offending artifact, and "return a corrected full MutationPlan."

Decoding: temperature 0.2, structured output enforced against the Zod-derived
JSON schema, max_tokens 6000. Model: Sonnet-class default; Opus-class for
repair rounds only (config-flagged for cost/quality tuning).

## 4. Context assembly details

Panel manifests include a one-line kernel-generated description (from title +
declared queries) so the model can target "the chart at the top" without all
code. Renames in flight (I4 map) included so references resolve. If registry
+ manifest exceed 12k tokens (power user), drop panel descriptions
least-recently-viewed first — never drop the registry.

## 5. Quality measurement (wired from day one)

attempts table records outcome + error_code + latency + tokens.
Derived metrics: first-pass commit rate (target >= 90%), repair-save rate,
clarify rate (healthy band 5–15%: lower means guessing, higher means
annoying), discard rate by diff kind (which mutation types disappoint).
The 25-intent regression suite (doc 08) replays canned S1 contexts through
S2–S4 nightly against the live prompt; a drop > 5pp blocks prompt changes.

## 6. Concurrency and idempotency

One mutation in flight per app (UI-enforced; kernel guards with a lock).
Slider is disabled during S4–S6. Commit is idempotent via attempt id;
a crash between migrate and log-append is impossible (same transaction);
a crash between commit and iframe swap self-heals on reload (manifest is
derived from the log, not from live iframes).

## 7. Panel runtime failure handling (post-commit)

Error boundary per iframe: uncaught error or render timeout -> boundary card
(Repair / Roll back this panel / Dismiss). "Roll back this panel" restores
the previous blob of that panel_id only, as a NEW commit (panel-scoped
revert), preserving linear history. Repair = one-round fix flow with the
runtime error; result arrives as a normal preview (S5), never auto-commits.
