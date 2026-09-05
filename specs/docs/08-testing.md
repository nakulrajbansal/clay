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
    seed AND the active row projection is bit-equal. Post-version physical
    tables/columns stay as inactive tombstones; roll-forward or compatible
    re-add restores their prior rows/values. System-side missing-cell markers
    backfill only rows inserted while a column was inactive, preserving an
    explicit NULL that existed before rewind.
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
It also boots a declared-write panel that attempts an insert immediately:
the write must fail until a fixed-runtime rendered action mints a grant.

## 4. The 30-case regression suite (the product's exam)

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

## 7. A/B authority and protection gates

Schema and kernel tests exhaustively cover canonical uint64/ID/digest grammar,
strict target tuples, exact Temporary eligibility, and total device-state
precedence. Every unreadable, denied, unknown, corrupt, quota, attach, and
unclassified vector must fail closed. Tests vary each target member independently;
a checkpoint or handle from another generation/revision/digest never authorizes
current success.

A release-bound physical-transaction harness kills the worker/process at every
named boundary, reopens from a fresh process, and checks the complete app/catalog
fingerprint. It must prove all-before or all-after for the exact runtime/VFS and
journal settings, or prove the selected colocation/recovery journal reconciles
before any read/write port opens. Missing, stale, or failing certification keeps
affected operations disabled or read-only/export-only. UI tests cannot substitute
for storage evidence.

`pnpm verify:transaction-core` is the prerequisite mechanism gate. Its first
stress result covered 180 Chromium/SQLite-WASM/SAH-pool kill/reopen cases across
three attached databases with transactional DDL, row, system metadata, and
catalog surrogates. It remains non-release evidence until the same registry adds
production semantic hook/oracle coverage, concurrency, every supported durable
runtime, and the native commit/durability boundary.

ADR-049 adds focused schema/kernel gates for strict catalog snapshots, immutable
generation binding, monotonic expiring leases, stale epochs, explicit fresh
initialization, exact schema/constraint denial, cross-table identity validation,
durable namespace inventory, ambient SQL denial, async authority denial, and a
bounded synchronous SHA-256 implementation checked against an independent Node
crypto oracle. Raw SQLite-pair hashing is explicitly rejected by review and spike
evidence. Merkle tests cover independent leaf/bucket/root golden vectors, raw-byte
ordering across locales, exact 1,024-bucket persistence, no-op zero-write behavior,
read-only meaningful-change preflight, authenticated root-vector/count/touched-bucket
prestate, omitted leaf DML rollback,
lost-bucket rollback, corruption denial, and a one-leaf update at 5,000 leaves under
the existing 300 ms kernel scale budget. Canonical census tests independently count
every covered SQLite row; bind semantic row/field identities, 20 table schemas, four
kernel indexes, supported user indexes, and `sqlite_sequence`; validate attachment
bytes; reject credential settings and unknown objects; prove telemetry/Merkle
exclusions; and compare full
rebuild output with the persisted Merkle root before and after direct divergence.
Additional adversarial gates cover SQLite-WASM int64 min/max and safe-number
boundaries, lone-surrogate and invalid raw UTF-8 rejection, structured-schema
equivalence with closed DEFAULT/COLLATE/DESC rejection, every system identity policy with a real
row, and user-index authorization, repoint rejection, rename/reindex,
rewind/roll-forward/truncation/future/archive lifecycles.
Target-authority tests prove exact two-table schema read-back, strict header/high-water
invariants, Merkle-derived non-self-referential evidence, census-root stability,
idempotent response-loss reservation, monotonic high-water, abandoned gaps, and no
current-revision advancement before a data commit.
Catalog tests prove strict mirrored reservation, commit, abandonment, immutable journal
genesis, lease-contained lifecycle times, globally unique ordered catalog events,
expected target and request binding, sealed-generation/current-head separation, exact
read-back, stale reuse rejection, and read-only committed response replay.
They also reject root-generation ABA rollback, missing or orphan generation events,
foreign and older finalizing leases, non-UTC lifecycle times, and generation activation
before a complete lineage journal exists.
The guarded coordinator tracer authenticates expected target and Merkle prestate,
returns a zero-write no-op without invoking mutation or creating a reservation,
durably reserves before a meaningful write, and commits data, Merkle leaves/root,
target current revision, catalog head, both journal finalizations, catalog generation,
and full-census read-back in one guarded transaction. The catalog is opened only from
the coordinator's guarded driver; authority classes are absent from the public kernel API,
and no catalog object can enter through the commit input. Injected failure rolls all current
state back and abandons the same revision
in both journals. Committed rows retain the exact state
digest plus original expected revision/digest and canonical fingerprint of a private
cloned change set. A matching response-loss retry of the current committed operation
returns its original evidence without mutation or another reservation; historical
replay fails closed until a current-anchored journal chain exists. Reuse with another
target or change set fails closed.
Omitting catalog generation/fence from a committed retry fails before evidence is returned;
target-only journal evidence cannot satisfy response-loss reconciliation.
The coordinator invokes the trusted canonical census itself and compares root plus leaf
count; callers cannot attest with an arbitrary digest callback, and callback mutation of
caller-owned change arrays cannot alter the reserved request. A changing input accessor is
read once; both persisted rows must retain that single parsed operation ID before success.
Overridden outer and field-array iteration methods are not invoked during capture; mutation
of their original elements after fingerprinting still rolls back against the private copy.
Object and callable-function thenable mutation callbacks are rejected before Merkle
publication and their synchronous writes roll back. Physical
driver tests prove raw-driver, forwarding-wrapper, and second-wrapper transactions cannot
bypass the one guard or return success inside a later rollback. Public `BEGIN`, `SAVEPOINT`,
`COMMIT`, `ROLLBACK`, `ROLLBACK TO`, and `RELEASE` are rejected; private physical depth and
autocommit checks bracket every receipt. Runtime probes also pass sqlite-wasm options
objects, malformed bind containers, and trigger DDL followed by rollback/savepoint
replacement; primitive input validation plus the engine authorizer rejects each before a
receipt can escape. A freshly sampled trusted worker clock
authorizes reserve, commit, retry, and abandonment; the final fence is checked before the
mutation callback and caller journal timestamps are not accepted.

Crash recovery tests leave both journals reserved, advance beyond lease expiry, then
prove one same-driver transaction revokes the old owner, advances write epoch and
catalog generation, mints a new lease, abandons both rows on the same permanent gap,
and permits revision 2 to commit. Catalog corruption tests also rewrite the app row,
generation descriptor, and retained IDs coherently while leaving the original seed event;
the full immutable seed target still rejects the re-anchor. Commands without a trusted
registry and all production paths lacking catalog/fence integration remain rejected.
Recovery corruption also relabels a takeover as ordinary abandonment and appends a
separate lease event; the bidirectional event contract rejects that incomplete account.
No-op matrices, new archive target evidence, real OPFS, every production writer and
Store RPC port, concurrent CAS, reservation gaps, broader performance fixtures, and
named crash hooks remain required before writes are enabled.

## 8. Launch criteria (all must hold)

L1 regression gate green 5 consecutive nights;
L2 hostile-panel corpus green;
L3 PB1–PB4 at 10k runs each;
L4 privacy E2E green;
L5 a stranger (not Nakul) reaches a kept mutation unassisted in < 5 min,
   3 of 4 test users.
