# 02 — System Architecture

## 1. Topology

Client-first. The browser holds the product; the backend is an accessory.

```
BROWSER ─────────────────────────────────────────────────────────────
 Main thread
   Shell (React, trusted)
     ├─ ConversationRail ── MutationClient
     ├─ PanelHost (one per live panel; owns iframe lifecycle)
     ├─ PreviewHost (shadow panel + diff card)
     ├─ TimeSlider / HistoryView
     └─ DataView / Settings / Onboarding
   Kernel (TypeScript, trusted, framework-free)
     ├─ Bridge (postMessage router, Zod-validated)
     ├─ QueryCompiler (Query object -> SQL + params)
     ├─ MigrationEngine (plan executor + inverse verifier)
     ├─ VersionLog (commit chain, rollback executor)
     ├─ Validator (acorn AST walk, budgets, query consistency)
     ├─ Observer (usage events -> heuristics -> suggestions)
     └─ ExpressionEngine (safe eval for computed columns)
 DB Worker
   SQLite WASM + OPFS VFS; owns user.db and system.db exclusively
 Panel iframes (untrusted, N ≈ 3–20)
   PanelRuntime (tiny fixed script): receives code blob, executes module,
   injects `clay` proxy, renders vnode vocabulary into its own DOM
──────────────────────────────────────────────────────────────────────
BACKEND (hosted mode only)
   Hono app: /auth/magic-link, /me, /mutations/plan (model proxy)
   Postgres: accounts, quotas, mutation counters. NO user app data.
ANTHROPIC API
```

## 2. Trust boundaries

B1 Shell/Kernel <-> Panel iframes. Crossed only by the Bridge protocol
   (doc 06). Everything on the panel side is permanently untrusted.
B2 Browser <-> Backend. Carries auth + mutation requests (schema-shapes
   and intent only, never records).
B3 Backend <-> Anthropic. Server-held key; per-user rate limits upstream.
B4 (BYO mode) Browser <-> Anthropic directly; B2/B3 not exercised.

Rule: data records cross NO boundary. They live and die inside B1's
trusted side.

## 3. Threading and ownership

The DB Worker exclusively owns SQLite (OPFS sync access handles require a
worker; exclusivity avoids lock contention). Ordinary DB access is async message
RPC: {id, op, payload} -> {id, ok, result | error}. Intent and panel-repair calls
add one transferred, per-call MessageChannel. The worker's closed planner protocol
binds every request, response, cancellation, and finalization acknowledgement to a
worker-minted boot epoch, monotonic intent generation, immutable context id, attempt
(0 or one authorized repair at 1), and sequence. Worker-side waits for a model round
or finalization acknowledgement fail after 180 seconds. The trusted shell lazily runs MutationClient on that port with
ECMAScript-private provider access; no credential or model fetch enters the DB
worker. Remote response bodies are streamed under fixed byte ceilings and provider
calls have their own 180-second deadline. The Kernel exposes typed async wrappers; panels never speak to either
worker protocol directly.

Panel iframes never touch the worker. Their db calls route:
iframe -> Bridge (main) -> Kernel -> DB Worker -> back. Watch subscriptions
are registered in the Kernel; on relevant table writes, the Kernel re-runs
compiled queries (debounced 50ms, batched per commit) and pushes rows to
subscribed panels.

## 4. State model

Four state stores, deliberately separate:
- Device app authority: a DB-worker-owned durable catalog records app identities,
  selected immutable generation, lineage/revision/digest high-water marks, write
  epoch, and pending lifecycle jobs. Shell `localStorage` may cache a projection
  but cannot prove existence, choose a target, allocate identity, or authorize a
  write. On first migration, a catalog manifest declares the complete physical namespace
  set and preallocated identities before any legacy target changes. Each target is adopted
  atomically and interrupted work resumes on the next worker. Boot returns a detached full
  catalog projection that replaces the shell cache; requested selection is validated or
  published through catalog CAS before opening the target.
- Persistent per-app state: SQLite (user.db + system.db). Source of truth for
  records, shape, history, and app-owned metadata. Every authorizing handle binds
  the catalog-selected `(appInstanceId, activeGenerationId, lineageEpoch,
  stateRevision, stateDigest)` tuple.
- Shell UI state: React state (panel layout cache, open dialogs, slider pos).
  Reconstructible from worker authority and SQLite at any time; never authoritative.
- Panel-local state: inside each iframe (form inputs, chart hover). Ephemeral
  by design; a panel reload must be lossless for user DATA (which is in the DB),
  only losing transient interaction state.

Storage open and protection state follow ADR-048. An unreadable/ambiguous expected
store fails closed; it never becomes a writable memory replacement. Cross-database
atomicity remains unclaimed until the exact production topology or selected
recovery fallback passes release-bound crash/reopen certification.

Catalog schema 1 and target digest schema 1 follow ADR-049. Catalog open and fresh
initialization are separate APIs. The live SQLite driver is deny-by-default for SQL
writes; one internal synchronous coordinator must validate authority incarnation,
write epoch, lease, selected complete target, and operation identity before opening
the outer transaction. Long-lived Store RPC ports receive no ambient exception.
The guarded `DbDriver` and its write opener are separate frozen capabilities; no exported
object exposes both. Every production request is captured without accessors, assigned one
stable operation, and mirrored as `prepared` then `invoked` before any live primitive.
Terminal response bytes are hash-bound across target and catalog. Ambiguous `invoked`
requests are never re-entered after restart, and canonical no-ops complete from a
revalidated shadow without invoking the live Store.
Target digest schema 1 is a target-owned, 1,024-bucket canonical logical Merkle map.
It hashes stable logical keys and type-tagged values, commits attachment content
digests rather than retained bytes, and excludes its own metadata plus device-local
telemetry. Ordinary writes update only affected leaves and buckets; boot, checkpoint,
import, and restore perform full rebuild audits. Shadows remain independent and never
attach the live catalog.

## 5. Sequence: a mutation end to end

```
User types intent
 -> ConversationRail -> WorkerClient opens one planner MessageChannel
 -> DB Worker: MutationPipeline captures immutable S1 context              [local]
      reads: schema registry, panel manifest, last 5 summaries; NEVER rows
 -> trusted Shell lazily loads MutationClient and sends plan request       [remote]
      provider access remains native-private; only S1 shapes + intent leave
 <- opaque bounded raw output returns on the bound per-intent port
 -> DB Worker: decode + Zod + Kernel.Validator.check(plan)                 [local]
      fail -> worker-authorized repair attempt 1 (once) -> fail -> amber card
 -> Kernel.dryRun(plan):
      DB Worker: BACKUP user.db -> shadow.db
      MigrationEngine.apply(plan.migration, shadow)
      PreviewHost boots panel iframes against shadow binding
      smoke render; runtime error -> repair round (once)
 -> DB Worker requests generation finalization on the planner port
      shell acknowledgement is FIFO-ordered after all earlier terminal traffic
 -> PreviewHost publishes proposed panels + diff card only after finalization
 User: Keep
 -> Kernel.commit(plan):  [single transaction]
      MigrationEngine.apply(migration, user.db)
      VersionLog.append(commit{migration, inverse, blobs, summary})
      PanelHost hot-swaps iframes (new blob URLs)
      Observer.record("mutation_kept")
 User: Discard -> shadow dropped, nothing recorded but the attempt count
```

## 6. Sequence: rollback to version K

```
Slider drag -> TimeSlider (preview mode, read-only render at K)
 "Make this the latest"
 -> Kernel.rollback(K): [single transaction]
      for v in N..K+1 desc: MigrationEngine.apply(commit[v].inverse)
      VersionLog.truncateAbove(K)  (after explicit warn)
      PanelHost restores manifest at K from blobs
```

Preview mode does NOT run inverses; it renders panels at K against current
data, with fields unknown at K simply not selected. Only "make latest"
touches the schema. This keeps scrubbing instant and side-effect free.

## 7. Module dependency rules (enforced by lint)

kernel/* imports nothing from shell/*. shell/* may import kernel public API
only (kernel/index.ts). panels have no imports at all (validated). The
backend shares one package with the client: schema/ (Zod definitions for
MutationPlan, Bridge messages, Query) — single source of truth for shapes.

## 8. Performance budgets

Cold start (returning user, warm cache): interactive < 1.5s.
Panel render after data write: < 100ms p95 (debounced watch).
Slider scrub: version render < 500ms p95.
Mutation round trip (model included): < 15s p50, < 30s p95.
Memory: < 250MB with 20 panels and 50k rows.
Budgets are asserted in the perf test harness (doc 08), not aspirational.

## 9. Directory layout (target repo)

```
clay/
  packages/
    schema/        zod types shared client/server
    kernel/        bridge, query, migrate, version, validate, observe, expr
    shell/         react app (vite)
    panel-runtime/ the fixed iframe bootstrap (built to a single file)
    backend/       hono app
  specs/           THIS PACKAGE, checked in; CLAUDE.md points here
  tests/           regression intents, property tests, fixtures
```

## 10. Daily Home projection boundary

Today and Inbox are trusted, local read-time projections, not durable copies of
canonical records. Each source adapter returns a bounded page, a source-native
watermark and status epoch, and closed exact or partial completeness. The worker
performs deterministic ranking and deduplication against one snapshot basis. A
cursor binds that basis, every adapter continuation, page scope, ranking version,
app timezone, local date, and the earliest future instant at which time alone can
change the result. A basis change returns an empty stale-cursor error, never a page
mixed from two snapshots.

The basis starts with the catalog-selected `(appInstanceId, activeGenerationId)`
and also binds the canonical ready/issue profile-resolution partition because that
partition changes configuration status. Profile IDs, source gaps, representatives,
and items use byte-stable ordinal comparison rather than host-locale collation.
Cursor payloads have one closed canonical JSON encoding, all seven adapter slots,
and a domain-separated SHA-256 integrity checksum. Decoding rejects malformed,
non-canonical, or checksum-mismatched envelopes; trusted verification additionally
rejects another basis or page scope and any instant at or after the validity boundary.

The app stores one recognized IANA timezone identifier and preserves that exact
string. Readers accept valid IANA links across ICU revisions instead of rewriting
an archived identifier to a runtime-specific preferred alias.

Due-record sources resolve only reviewed stable semantic identities. They do not
infer a field from a label, array position, or apparent value. A missing or
incompatible binding becomes a visible Setup or Fix state. Read projection code
uses an injected clock and cannot obtain the physical driver or write opener.
Shell navigation is a presentation choice; it cannot authorize record,
disposition, reminder, or recurrence writes.

The first D1 implementation may expose only Open and Setup/Fix navigation actions. Recovery
is represented only as an unavailable or partial source status until B3/B4 supplies a stable
incident identity; D1 does not invent a recovery target. Complete,
Capture, Snooze, Dismiss, device reminders, and recurrence stay unavailable until
their separately typed worker-owned operations and dependency gates pass. Hosted
reminder infrastructure is not part of the local projection boundary.

`DailyHomeSnapshotV1` is a strict transport shape, not authority. The trusted kernel
builder performs bounded descriptor capture, derives aggregate completeness and the
SHA-256 basis digest, verifies that every rendered section occurrence exactly matches a
source occurrence, enforces the fixed source-to-section registry, chooses one canonical
representative per rendered identity, and returns a recursively frozen graph. Section
occurrence totals come from every contributing source while rendered totals count only
the deterministic representatives. Production consumers accept only that verified
output. Row, automation, saved-view, and semantic target fields reuse their canonical
subsystem identifier formats rather than generic bounded strings.
