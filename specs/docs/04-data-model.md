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

navigator.storage.persist() requested at first commit; status surfaced in
Settings. Usage estimate shown. usage_events ring-buffer trimmed at 50k.
shadow.db deleted after every pipeline run. If OPFS unavailable (old
browser), boot falls back to in-memory + prominent "your data will not
persist" banner + export nag — supported but hostile on purpose.
Attachments are capped at 10 MB each, 20 per field, 200 MB active bytes, and
250 MB total retained bytes per app. Removed bytes are retained for 30 days so row restore remains useful, then
the trusted cleanup action may purge only old and currently unreferenced blobs.
Executable and active-content file types are rejected, and common binary formats
must match their declared signatures.
