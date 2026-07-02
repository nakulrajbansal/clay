# CLAUDE.md — Clay build instructions

You are building Clay, a malleable personal application. The COMPLETE
specification lives in specs/ (this package). Read specs/README.md for the
doc map. The specs are binding; where code and spec conflict, the spec wins
unless an ADR (specs/docs/10-decisions.md) or gap resolution
(specs/docs/11-gap-resolutions.md) is added first.

## Ground rules
1. Follow the build order in specs/docs/09-build-plan.md, including P0.
   P0 artifacts already exist in this package (exemplars/, schema/,
   tests/regression-intents.md, shells/) — verify them against the specs as
   your first task and flag inconsistencies before writing kernel code.
2. Principles (specs/README.md) are non-negotiable, in priority order.
   When in doubt: data outlives interface; reversible; untrusted; model
   only at reshaping; preview before commit.
3. The shared Zod schemas in schema/ are the constitution for all shapes
   (MutationPlan, Query, Bridge messages). Changing them after week 2
   requires an ADR entry in the same commit.
4. Never add a runtime dependency to packages/kernel beyond:
   @sqlite.org/sqlite-wasm, zod, acorn. Shell deps: react, react-dom,
   vite tooling, chart.js (SRI-pinned). Justify anything else in an ADR.
5. Every Validator rule (doc 06 §5, V1–V7) ships with pass+fail fixtures
   in the same PR that implements it.
6. The hostile-panel corpus (doc 08 §3) is append-only. If you find a
   sandbox bypass while developing, add the fixture FIRST, then fix.

## Repo conventions
- pnpm workspaces per specs/docs/02-architecture.md §9 layout.
- TypeScript strict everywhere; no `any` in kernel or schema packages.
- Tests: vitest (unit/property via fast-check), Playwright (integration,
  privacy E2E, axe-core a11y). CI order: typecheck -> unit -> property ->
  integration -> regression gate (once the pipeline exists).
- Commits: conventional (feat/fix/test/docs/adr). One milestone exit test
  per week must be a real executable test, not a checklist item.
- No secrets in repo. Model ids and endpoints in config/models.ts only
  (see gap G2). Backend env via .env.example.

## Model integration facts (verified 2026-07; re-verify at implementation)
- Structured outputs: GA, `output_config: {format: {type: "json_schema",
  schema}}`. Respect grammar complexity limits: the API-level schema is the
  SIMPLIFIED MutationPlan (schema/mutation-plan-api.json); full validation
  is client-side Zod (gap G1 / ADR-013). Keep the API schema byte-stable
  for grammar caching.
- Default model: claude-sonnet-4-6; repair escalation behind MODEL_REPAIR
  flag. Docs: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- BYO mode: direct browser calls with the
  anthropic-dangerous-direct-browser-access header (confirm name in docs).

## Definition of done, per week (from doc 09)
W1: scripted spine test green (create/insert/computed/rollback/rollforward,
    data bit-equal) + PB1 small-scale.
W2: the sentence "add a priority field to tasks and show it as a colored
    badge" commits end-to-end on all three archetype shells.
W3: launch criteria L2 + L3 green; regression runner executing nightly.
W4: L1–L5 green; deployed; demo video recorded.

## What NOT to build (pre-decided noes)
Multi-user, branching history, raw HTML panels, CSV import, external
integrations, mobile polish, i18n, offline mutation queueing, panel
marketplace, code export. See doc 01 §3 and doc 11 G17.

## When you (Claude Code) are uncertain
Prefer: (a) check the exemplars — they are executable intent; (b) check the
ADR log; (c) implement the narrower interpretation and leave a TODO(spec)
comment plus a line in specs/OPEN-QUESTIONS.md. Never widen a capability
surface (Bridge, Validator, migration vocabulary) to make a test pass.
