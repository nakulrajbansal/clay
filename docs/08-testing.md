# 08 — Testing Strategy and Quality Gates

Testing priority mirrors the trust boundaries: the Bridge, the
MigrationEngine, and the Validator get depth; the shell gets breadth.

## 1. Unit layer

QueryCompiler: golden tests (Query object -> exact SQL + params) for every
op incl. or-groups, aggregates, date ops; injection corpus (hostile field
names/values) must all fail validation BEFORE SQL assembly.
ExpressionEngine: grammar table tests, type-check failures, budget trip.
Validator: one fixture per rule V1–V7, pass and fail cases; the forbidden-
identifier list tested via generated probes (each identifier, 3 syntactic
positions: bare, shadowed, member).
MigrationEngine: per-op forward/inverse pairs against fixture DBs.

## 2. Property-based tests (fast-check) — the crown jewels

PB1 migrate/rollback round-trip: for random sequences of valid forward
    plans (length <= 12), apply all, then roll back all -> schema equals
    seed AND all row data bit-equal (hidden columns included).
PB2 fold determinism: replaying version_log on an empty store reproduces
    the exact registry + schema at every version.
PB3 query safety: random Query objects (valid per schema) never produce SQL
    referencing unregistered identifiers; random INVALID ones always throw
    pre-compilation.
PB4 expression totality: random well-typed expressions never throw; random
    ill-typed ones always E_EXPR at check time, never at eval time.

## 3. Bridge/sandbox integration

Headless (Playwright): boot a hostile panel corpus — each tries one escape
(fetch, parent access, prototype pollution, oversized payloads, watch bombs,
confirm spam, undeclared-table query, forged panel id) — assert: zero
network requests from frames, correct E_ codes, strikes/boundary behavior.
This corpus is append-only; every future bypass found becomes a fixture.

## 4. The 25-intent regression suite (the product's exam)

Canned S1 contexts (3 archetype apps: grooming CRM, PMO tracker, reading
log) x intents spanning: add field, enum status, computed column, chart,
form, filter+event pair, rename, remove panel, vague intent (expects
clarify), impossible intent (expects graceful decline), compound intent,
and 5 adversarial intents (asks for deletion, network, "email me", raw SQL,
another user's data) which must produce safe plans or refusals.
Runner executes S2–S4 against the live prompt nightly and on every prompt/
schema PR. Gate: first-pass commit >= 90%, adversarial safety 100%,
clarify-when-expected >= 4/5. A >5pp regression blocks merge.

## 5. Privacy commitment tests (backing doc 06 §7)

E2E: full usage session under Playwright with network interception ->
assert zero requests carrying table rows; offline-mode session (network
disabled post-load) -> all non-mutation features function; export/import
round-trip -> byte-level DB equality.

## 6. Performance harness

Seed 50k rows / 20 panels fixture; assert budgets from doc 02 §8 in CI on a
throttled profile (4x CPU slowdown) so numbers reflect median hardware.

## 7. Launch criteria (all must hold)

L1 regression gate green 5 consecutive nights;
L2 hostile-panel corpus green;
L3 PB1–PB4 at 10k runs each;
L4 privacy E2E green;
L5 a stranger (not Nakul) reaches a kept mutation unassisted in < 5 min,
   3 of 4 test users.
