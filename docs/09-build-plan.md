# 09 — Build Plan

## 0. Pre-code week ("P0") — do this BEFORE any implementation

P0.1 Hand-write the ten few-shot exemplars (doc 05 §3) as complete
     MutationPlans against the three archetype apps. This is the single
     highest-leverage task in the project: it pressure-tests the ClayAPI,
     the vocabulary, and the migration set on paper. Every gap found here
     is 10x cheaper than found in week 3.
P0.2 Hand-render two exemplar panels' vnode trees to static HTML mockups;
     confirm the component vocabulary can express the target UI (compare
     against the approved main-screen mockup).
P0.3 Freeze the Zod schemas (MutationPlan, Query, Bridge messages) in the
     shared package — they are the constitution; changes after week 2
     require an ADR entry (doc 10).
P0.4 Write the 25 regression intents (titles + expected outcome only).
Exit: a reviewer can read exemplars alone and predict the product.

## Week 1 — the spine
Kernel skeleton; DB worker + OPFS; registry; MigrationEngine with
create_table/add_column/backfill/create_computed + inverses; VersionLog;
QueryCompiler; ExpressionEngine; ONE hand-written panel through the real
Bridge + PanelRuntime rendering real data.
Exit test: scripted sequence — create table, insert rows, add computed
column, roll back, roll forward — data intact, PB1 passing at small scale.

## Week 2 — the loop
Prompt v1 from exemplars; MutationClient (hosted + BYO paths); Validator
V1–V7; shadow dry-run; PreviewHost + diff card; commit + hot swap.
Exit test: "add a priority field to tasks and show it as a colored badge"
end-to-end from typed sentence, on all three archetype apps.

## Week 3 — trust
Time slider + history view + scrub-preview; panel error boundary + panel-
scoped revert + one-round repair; full migration vocabulary; Data view;
export/import; regression suite runner live; hostile-panel corpus v1.
Exit test: launch criteria L1 trending, L2/L3 green.

## Week 4 — the demo
Onboarding + three starter shells; Observer with two heuristics
(token-promotion, repeated-filter); settings; landing page with DevTools
verification section; quota UI; deploy (Vercel + thin backend); 90-second
demo video: day-1 shell -> five sentences -> personal app -> slider rewind.
Exit: launch criteria L1–L5.

## Cut order under pressure
Observer -> starter shells (ship one) -> Data view -> repair round (keep
boundary + panel revert). NEVER cut: preview-before-commit, inverses,
Validator, export.

## Post-launch instrumentation (first 30 days)
Watch: first-pass commit rate by diff kind; validator-rejection reasons
(= the v1.1 component/vocabulary roadmap); clarify rate; day-14 mutation
retention. One prompt iteration per week max, always behind the gate.
