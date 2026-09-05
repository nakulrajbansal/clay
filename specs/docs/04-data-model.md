# 04 — Data Model, Migrations, and Versioning

## 1. Physical layout

OPFS directory /clay/: user.db, system.db, shadow.db (transient),
exports/ (staged .clay archives). SQLite WASM (official build), OPFS
sync-access-handle VFS, WAL off (single writer worker), page_size 8192,
foreign_keys on.

## 2. user.db

Only the MigrationEngine issues DDL for registered user tables. The kernel
also owns `row_history` and `__clay_attachments`; neither is queryable by panels.
Every user table gets kernel
columns: id TEXT PK (uuidv7), created_at, updated_at, deleted_at (nullable).
User columns follow the registry. SQLite types map: text->TEXT,
number->REAL, integer->INTEGER, boolean->INTEGER(0/1), date->TEXT(ISO),
enum->TEXT, json->TEXT(validated), rich_text->TEXT, relation(one)->TEXT UUID,
relation(many)->TEXT JSON UUID array, and attachment->TEXT JSON attachment-ID
array. Computed, lookup, and rollup columns have NO
physical column — evaluated by the kernel at query time and projected into
results. Relation projections expose `{id, table, label}` objects while storage
continues to use stable IDs. Lookups and rollups always read current target rows.

## 3. system.db schema

```
tables_registry(table_name PK, version, spec_json, created_by, updated_at)
version_log(version INTEGER PK, parent, created_at, intent_text,
            summary, diff_json, migration_json, inverse_json)
panel_blobs(version, panel_id, code TEXT, placement_json, declared_q_json,
            PRIMARY KEY(version, panel_id))
panel_tombstones(version, panel_id)
usage_events(id PK, at, kind, subject, detail_json)     -- ring, cap 50k
suggestions(id PK, kind, subject, state, created_at)    -- state: shown|
                                                        -- accepted|dismissed
operation_batches(id PK, at, source, summary, changed_count, created_json,
                  undone_at)
automations(id PK, definition_json, created_at, updated_at, last_event_seq)
record_events(seq PK, id, at, table_name, row_id, kind, changed_fields_json,
              origin, row_json)
automation_runs(id PK, automation_id, at, trigger_key, status, matched_count,
                changed_count, batch_id, error_code, undone_at)
automation_matches(automation_id, row_id, PRIMARY KEY(...))
notifications(id PK, automation_id, run_id, title, body, table_name, row_id,
              created_at, read_at, dismissed_at)
settings(key PK, value_json)                            -- non-secret per-app state only
attempts(id PK, at, intent_text, outcome, error_code)   -- kept|discarded|
                                                        -- failed; analytics
```

## 4. Migration vocabulary (v1, closed set)

Forward ops (generatable): create_table{table, columns[]},
add_column{table, column}, rename_column{table, from, to},
add_enum_value{table, column, value}, add_index{table, column},
backfill{table, column, value | expr}, create_computed{table, column, expr},
update_computed{table, column, expr}, hide_column{table, column},
set_required{table, column, required, default_for_existing?}.

ColumnSpec types are text, number, integer, boolean, date, enum, json,
computed, relation, lookup, rollup, rich_text, and attachment. A relation
declares target_table, one|many cardinality, optional uniqueness, and a display
field. A lookup names a relation field plus target field. A rollup names a
relation field, optional target field, and count|sum|avg|min|max.

Kernel-only ops (appear ONLY inside inverses): drop_table_if_created_by_this,
drop_column_if_added_by_this, remove_enum_value_if_unused, unhide_column,
drop_index, restore_expr, unset_required.

Invariants the MigrationEngine enforces before executing anything:
I1 every forward plan carries an inverse;
I2 inverse structurally reverses forward (op-by-op mirror check);
I3 no forward op is destructive (hide, never drop; enum values only added);
I4 rename keeps a rename-map so old panel queries resolve during the same
   commit's panel swap;
I5 all ops in one plan target <= 3 tables (complexity budget);
I6 backfill exprs use the safe expression language only.

Execution: single SQLite transaction spanning DDL + backfills + registry
update + version_log append. SQLite permits DDL in transactions — one of the
quiet reasons SQLite is the right store here.

## 5. Versioning semantics

Linear chain. App-state(N) = seed schema ⊕ migrations 1..N; live panels(N) =
latest blob per panel_id at <= N minus tombstones at <= N.

Rollback to K (authoritative): apply inverses N..K+1 in reverse inside one
transaction; truncate log above K; restore panel manifest at K.
Because of I3, inverses are information-preserving: hidden columns retain
data; roll-forward (before truncation) restores visibility bit-perfectly.

Rows created "between" versions: retained always (Principle 1). At version K
they render without post-K columns; that is a projection, not a loss.

Scrub-preview: render-only, no inverses (doc 02 §6).

## 6. Safe expression language (shared: computed columns, backfills, eval)

Grammar (Pratt parser, ~200 LOC):
  expr := literal | field | unary | binary | call | ( expr )
  binary: + - * / % == != < <= > >= and or
  unary: - not
  calls (closed set): min max abs round floor ceil len coalesce
                      days_between(date,date) if(cond,a,b)
                      contains(text,text) lower(text) concat(...)
Types: number, text, bool, date(text ISO). Static type check at plan-
validation time against the registry; E_EXPR on any unknown field/function.
No assignment, no property access, no user-defined functions, no loops.
Evaluation budget: 10k steps (defensive; grammar can't loop anyway).

## 7. Connected records, batches, and automations

Linked values are stable row IDs validated against active target records. The
trusted Data view can convert text to links only after a fingerprinted preview.
Conversion keeps the source text physically and redirects presentation to a
live lookup, so rewind and roll-forward are exact.

Trusted bulk operations contain 1 to 500 closed mutations. The kernel validates
the complete set before one SQLite transaction, records before and after row
snapshots, and returns a durable receipt. Undo compares current rows with those
after snapshots and fails with E_CONFLICT rather than overwriting later work.

Automation definitions use a closed trigger, condition, and action vocabulary.
They cannot execute code, fetch, access credentials, or invoke a model. Event,
match-edge, due-date, daily, weekly, and manual triggers are evaluated locally
while Clay is open. Every trigger key is idempotent. Data actions use the same
atomic batch path, notifications stay local, and successful runs with a batch
can be undone unless a later edit makes the receipt stale.
Simulation and execution fail before mutation above 100 matching records,
including queued event snapshots. Definitions are capped at 32 KiB, stored text
values at 4 KiB, resolved output values at 16 KiB, and a complete plan at 1 MiB.
Record effects, notifications, successful receipts, and match bookkeeping commit
inside one transaction so retry cannot duplicate a partially recorded effect.

## 8. Export / import

.clay archive format 4 = zip{ manifest.json (format version, app name, counts),
user.db, system.db }. Archives are capped at 384 MB, the manifest at 64 KiB, and
must contain exactly one of each entry. Import disables SQLite trusted-schema
behavior and rejects unexpected tables, views, triggers, virtual tables, and
indexes before store construction. In-memory staging validates canonical physical
schema, the complete migration and panel timeline, registry state at the selected
version cursor, semantic metadata, automations, attachment signatures and
SHA-256 digests, references, and manifest totals. Installation reconstructs trusted
DDL and copies allowlisted rows into the live databases inside one transaction,
then completes a read-back check before commit. Export remains the backup and trust
artifact: the user can hold their whole app in one file.
Format 2 records inactive rollback tombstones and missing-cell markers. Format
3 additionally requires a complete private semantic registry and retains its
legacy active-table count semantics. Format 4 counts the full retained registry
and active attachment bytes. Formats 1 through 3 remain importable with local
metadata backfill where needed; malformed or partially guarded archives fail closed.

## 9. Storage lifecycle

The device catalog and every authorizing proof use the canonical target tuple
`(appInstanceId, activeGenerationId, lineageEpoch, stateRevision, stateDigest)`.
Release-local names such as archive or protection revision are aliases only and
must not become independent counters. IDs and uint64 decimal counters use the
closed ADR-048 grammars and never derive current authority from imported values.

Catalog schema 1 is device authority outside `.clay` archives. It contains one
authority root, retained opaque IDs, app rows, immutable generation descriptors,
origin leases, pending lifecycle jobs, and non-reusable lineage/revision
reservations. A partial table set is invalid and is never auto-repaired. Live app
snapshots expose only non-tombstoned entries, while retained identities prevent
reuse within the authority incarnation.

Digest schema 1 uses target-owned logical leaf and bucket tables in `system.db`.
There are exactly 1,024 deterministic buckets. Leaf keys bind stable entity or schema
identity; leaf payloads use canonical type-tagged framing. Attachment leaves include
validated content SHA-256 and metadata but not retained bytes. Digest tables, target
headers, and device-local telemetry are excluded from their own root. Catalog rows
and the new target-aware archive format store the resulting `stateSha256`. Format 4
archives remain legacy inputs and cannot certify a target. Exact table layouts and
golden vectors land with the Merkle tracer before any migration or writer is enabled.

Merkle framing v1 uses ASCII domain bytes and big-endian lengths. A leaf hashes
`"clay.state.leaf.v1" || U32(keyBytes) || keyBytes || U32(fieldCount)` followed by
fields sorted by raw UTF-8 bytes. Each field is `U32(nameBytes) || nameBytes || tag ||
U64(payloadBytes) || payload`. Tags are 0 null, 1 canonical int64 decimal where
zero is exactly `0` and `-0` is invalid,
2 finite IEEE-754 binary64 with negative zero normalized to zero, 3 UTF-8 text, and
4 attachment/content reference. Tag 4 payload is the raw 32-byte SHA-256 followed by
U64 content length; raw attachment bytes are not a leaf value.
INTEGER census values preserve the complete signed-int64 domain returned by
SQLite-WASM as either safe numbers or BigInts; unsafe JavaScript numbers are rejected.
TEXT census values must round-trip through fatal UTF-8 decoding of the raw SQLite
bytes, and JavaScript text with an unpaired surrogate is invalid.

Bucket assignment uses the first ten bits of
`SHA-256("clay.state.bucket-key.v1" || U32(keyBytes) || keyBytes)`. A bucket root
hashes `"clay.state.bucket.v1" || U16(bucket) || U32(leafCount)` and each leaf sorted
by key as `U32(keyBytes) || keyBytes || rawLeafSha256`. The state root hashes
`"clay.state.root.v1" || U16(1024)` and all 1,024 `U16(bucket) || rawBucketSha256`
pairs in numeric order. The empty root is
`sha256:578c0424ddaed67d6f0c081a40e3c95bd0c7db2a7a9002fd565c74622c26079d`.
The checked mixed-type leaf vector is
`sha256:0a08665ca489f226d5f132d126e42f8785afedcf9b6057720a5e7cc3192bd5a9`.
Target-owned `state_digest_leaves`, `state_digest_buckets`, and `state_digest_root`
tables are explicitly created and validated by the target-aware format; they are not
silently added to the current format-4 archive allowlist.
Canonical rebuild enumerates one row leaf for every physical row in registered main
tables, `row_history`, attachments, and all 16 archive-copied system tables. It also
commits `sqlite_sequence`, 20 table-schema leaves, the four kernel index definitions,
and every supported user index keyed by semantic table and field identity. Record and
field keys use semantic IDs plus canonical text or int64 components rather than
mutable presentation names. Attachment content is
rehash-validated during the full census, then represented by digest and length.
Table schemas are framed from ordered `pragma_table_xinfo` fields, including exact
default-expression bytes, rather than globally normalized SQL text. User indexes are
authorized by `add_index` semantic operation coordinates. Active indexes enter the
root; validated future indexes retained for roll-forward do not. Physical metadata
must match the authorized tableId/fieldId, operation coordinate, current table/field,
and non-partial index shape. This binding survives rename, rewind, roll-forward,
truncation, duplicate reindex after rename, and archive reconstruction. Main tables
use a closed generated grammar; trusted system table leaves additionally bind exact
fatal-decoded DDL bytes so behavior constraints cannot collide.
Legacy credential-bearing settings fail the census. The two private-metric tables and
the three Merkle tables are explicit exclusions; unknown tables, indexes, triggers,
views, partial Merkle state, malformed values, or divergent persisted roots fail
closed.

`navigator.storage.persist()` is requested through the protected-first-write
flow; status is evidence-derived and surfaced in Settings. Usage estimate shown.
`usage_events` ring-buffer trimmed at 50k. `shadow.db` is deleted after every
pipeline run. Unsupported or non-persistent storage may offer Temporary only
after readable authoritative inventories prove exactly zero apps, zero durable
namespaces, and zero pending operations, the loss boundary is displayed, and the
user explicitly chooses it. The same proof without choice creates no app/store.
Denied, thrown, locked, corrupt, quota, attach, unreadable, or unknown outcomes
open locked/read-only recovery and never seed a memory replacement.
Attachments are capped at 10 MB each, 20 per field, 200 MB active bytes, and
250 MB total retained bytes per app. Removed bytes are retained for 30 days so row restore remains useful, then
the trusted cleanup action may purge only old and currently unreferenced blobs.
Executable and active-content file types are rejected, and common binary formats
must match their declared signatures.
