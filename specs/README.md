# Clay — Design & Architecture Package (pre-code)

A malleable personal application: the user owns one app whose interface and
features are reshaped through natural language, while their data persists
beneath every change.

This package is the complete pre-implementation specification. Read order:

| Doc | Contents |
|-----|----------|
| docs/01-product-spec.md | Personas, jobs, user stories, UX flows, screen inventory, copy rules |
| docs/02-architecture.md | Component architecture, boundaries, runtime topology, sequence flows |
| docs/03-kernel-api.md | Full ClayAPI reference: types, semantics, errors, limits |
| docs/04-data-model.md | Store design, schema registry, migration vocabulary, versioning/rollback |
| docs/05-mutation-pipeline.md | Pipeline stages, MutationPlan JSON schema, prompt spec, repair loop |
| docs/06-sandbox-security.md | Threat model, iframe/CSP design, bridge protocol, validator rules |
| docs/07-backend.md | Endpoints, auth, quotas, BYO-key mode, ops |
| docs/08-testing.md | Regression suite, property tests, quality gates, launch criteria |
| docs/09-build-plan.md | Milestones, exit tests, cut order, post-launch instrumentation |
| docs/10-decisions.md | ADR log: every major decision, alternatives, and rationale |
| docs/12-roadmap.md | Product roadmap: vision → shipped phases (Phase 0 done; 1–4 ahead) |

Principles (binding, in priority order):
1. Data outlives interface.
2. Every change is reversible, atomically.
3. Generated code is untrusted code.
4. The model is invoked only at the moment of reshaping.
5. Preview before commit.

Naming: "Clay" is a working name. "Panel" = one generated UI unit. "Mutation" =
one user-initiated change (migration + panels). "Kernel" = the trusted runtime.
"Shell" = the trusted chrome around panels.

## Package contents beyond docs/

| Path | Contents |
|------|----------|
| CLAUDE.md | Build instructions for Claude Code (conventions, ground rules, DoD) |
| docs/11-gap-resolutions.md | Pre-code gap audit: 17 gaps found and resolved (G1-G17) |
| schema/index.ts | Zod constitution: Query, MigrationPlan, MutationPlan, Bridge |
| schema/mutation-plan-api.json | Simplified schema for API structured output (G1/ADR-013) |
| prompt/system-v1.md | System prompt assembly spec (sections + includes) |
| exemplars/ | 3 archetype contexts + the 10 few-shot MutationPlan exemplars (P0.1) |
| tests/regression-intents.md | The 25-intent suite + 5 clarify cases (P0.4) |
| shells/starter-shells.json | The 3 first-run shells: registries, panel ids, seeds (G9) |
| OPEN-QUESTIONS.md | Running log for spec gaps found during build |
| docs/00-original-design-v1.md | The original single-doc design (historical) |

## How to start (in Claude Code)
1. `git init`, commit this package under specs/ (CLAUDE.md at repo root).
2. First task: "Verify exemplars, schema, and shells against docs 03-06;
   report inconsistencies." (Exemplar 10 contains one intentional V4
   violation as a validator fixture - see its NOTE.)
3. Then follow docs/09-build-plan.md week by week.
