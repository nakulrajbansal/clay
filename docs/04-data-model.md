# 04 — Data Model, Migrations, and Versioning

## 1. Physical layout

OPFS directory /clay/: user.db, system.db, shadow.db (transient),
exports/ (staged .clay archives). SQLite WASM (official build), OPFS
sync-access-handle VFS, WAL off (single writer worker), page_size 8192,
foreign_keys on.

## 2. user.db

Only the MigrationEngine issues DDL here. Every user table gets kernel
columns: id TEXT PK (uuidv7), created_at, updated_at, deleted_at (nullable).
User columns follow the registry. SQLite types map: text->TEXT,
number->REAL, integer->INTEGER, boolean->INTEGER(0/1), date->TEXT(ISO),
enum->TEXT + CHECK(list), json->TEXT(validated). Computed columns have NO
physical column — evaluated by the kernel at query time and projected into
results (keeps migrations trivial and expressions instantly editable).

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
settings(key PK, value_json)                            -- mode, byo key, etc.
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

## 7. Export / import

.clay archive = zip{ manifest.json (format version, app name, counts),
user.db, system.db }. Import validates format version, opens in a staging
OPFS dir, runs integrity checks (registry vs actual schema; version_log
chain continuity; panel blob presence), then atomically swaps directories.
Export is also the backup story and a trust artifact: the user can hold
their whole app in one file.

## 8. Storage lifecycle

navigator.storage.persist() requested at first commit; status surfaced in
Settings. Usage estimate shown. usage_events ring-buffer trimmed at 50k.
shadow.db deleted after every pipeline run. If OPFS unavailable (old
browser), boot falls back to in-memory + prominent "your data will not
persist" banner + export nag — supported but hostile on purpose.
