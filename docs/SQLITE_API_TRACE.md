# Pinned SQLite trace: specialization blocked

This is source-development audit tooling, not a transaction or browser
certificate. The production initializer, shared-runtime plugin, WASM, VFS and
authority code are unchanged.

## Reproduce

```text
node scripts/sqlite-api-trace.mjs --check
```

`trace: MATCH` means the checked inventory matches these bytes. Its separate
verdict is **SPECIALIZATION_BLOCKED**. The generator permits only `retain-intact`
and rejects omission, unknown policy and changed inputs. The read-only
`--candidate` command prints a blocked inventory for inspection; it cannot
approve omissions or write/replace a runtime. There is no production plugin
hook or fallback optimizer.

The checked manifest is `packages/shell/config/sqlite-api-trace.json`.
`sqlite-api-trace.mjs` in that directory contains the generator and inventory.
`sqliteSyntaxInventory()` exposes the detailed, reproducible AST sites whose
digest is in the manifest. Calls, constructors, declarations/aliases, property
reads/writes/deletes, reflective enumeration, callback/object arguments, returns
and spreads are recorded. Computed access or an indirect call is **not resolved
by string matching** and never permits deleting a section.

## Provenance and scope

- Package: `@sqlite.org/sqlite-wasm@3.53.0-build1`; package bytes, browser index,
  Worker1 distribution, TypeScript parser bytes/version and shared-runtime
  extraction are bound by the manifest.
- Original browser index SHA-256:
  `f80870f0fa03a39a3338d17ed3fbea04808d344c88e724d90d5f37b9b7b83154`.
- Intact extracted initializer SHA-256:
  `35fb438f17dc39e3f3bf3ac8cf58810c5054c19d3224a289bd0af68b65ce6208`.
  It has 568,537 source characters / 568,539 UTF-8 bytes before minification.
- Unchanged WASM SHA-256:
  `02d7e48164395fa68f81c6ec33e9da5461be397dc57602ac0cd89b4bbba1d312`.
- Thirty explicit input files include the physical consumers, authority callers,
  preserved-handle/native-recovery fixtures, original/shared initializer tests,
  the trace implementation/tests and transaction certificate worker/runner.
  A second inventory binds all 317 production JavaScript/TypeScript source files across six packages,
  including paths: a new consumer outside the named roots invalidates the trace.
  The loader reads fixed repo/package source paths, not paths from a manifest or
  a user database. Linked source inputs fail closed.
- Eleven AST-checked initializer registrations plus their intervening code form
  a contiguous, gap-free partition of the complete initializer. Emscripten,
  struct binding, bootstrap, callback tables, asynchronous installation and the
  final initialization loop are retained, not dropped as unclassified gaps.

The syntax inventory is conservative, **not a complete points-to/closed
reachability proof**. Its initializer includes 1,132 computed accesses, 3,477
calls, 347 constructors, 1,370 bindings/aliases and 3,324 possible callback/object
escapes. These counts overlap semantically and are not counts of unused APIs.
Unknown AST/registration shapes, source changes or upstream changes cannot
produce an authorized specialized initializer.

## Required consumer paths

| Consumer | Required surface and side effects retained |
| --- | --- |
| `db.ts` | Initializer promise, OO1 DB constructors/exec/select/close, randomness and transaction authorizer callbacks, get-autocommit, database export and deserialize, WASM allocation, attached user/system/catalog topology |
| `sahpool-initialization.ts` | Version/VFS probes, original SAHPool installer, capacity/inventory/import/export/pause callbacks, original exclusive handles, association-header preservation and bounded I/O |
| `sahpool-journal-recovery.ts` | VFS/file/I/O struct constructors and layouts, installed function tables, scoped allocation/string conversion, exact original callback forwarding, scoped reserved-lock override, native child/super-journal cleanup |
| `native-recovery-shadow.ts` / production native recovery | Original struct binding and VFS installation, bounded shadow I/O, database constructors/attach/close, rollback-before-authority-read ordering and final all-target reclassification |
| Observer / automation consumers | The original physical transaction, three-database DELETE/FULL prerequisites, per-use original-handle proof and recovery capability; no new grant |
| Pinned Worker1/support entry | Startup readiness, message dispatcher, open with caller-supplied VFS/filename, query/export/errors/close, VFS enumeration and OO1 aliases |
| Transaction certificate fixture | Pinned initializer, real SAHPool setup, attached databases, statement cuts, rollback/close, integrity/journal/source-ID readback; **not rerun here** |

The checked call lists preserve alias spellings instead of falsely claiming that
every alias is a statically resolved CAPI target. All such unresolved objects,
callbacks and their initializing sections remain in the runtime.

## Executable omission counterexamples

`packages/shell/test/sqlite-initializer-oracle.test.mjs` builds the original
pinned package as an independent oracle and the intact extracted initializer
in separate owned VM/WASM realms. Tests compare exported names/descriptors,
struct helper surfaces, VFS registration and constructor deletion side effects;
they execute SQL/attached rollback, byte-exact export/deserialize, errors/close
and Worker1 memory/named-memory flows. Network access is denied. No host OPFS,
existing browser or user profile is opened.

Two **test-only**, AST-statement-removal mutants establish actual incompatible
outcomes. They are built in memory and never written or exposed as a production
generator option:

1. Without KVVFS JS initialization, `config-get` still advertises `kvvfs` from
   the unchanged WASM, but Worker1 cannot open a named-memory KVVFS database.
   The original and intact extracted initializers both open, query, export and
   close it. KVVFS is not merely browser localStorage code: its callback setup,
   `KVVfsStorage`, struct cleanup and named-memory behavior are observable.
2. Without the vtab initializer, `sqlite3.vtab.setupModule` and the
   `sqlite3_index_info` prototype helpers disappear. The original helpers run
   against real allocated structs; the mutant no longer has them. The KVVFS
   `create_module` helper is conditional on **both `__isUnderTest` and vtab**;
   it is not claimed to be an unconditional production dependency.

These counterexamples prohibit the proposed wholesale omissions under the
required exported-API/VFS compatibility contract. They do not prove that every
line of the initializer is necessary. A smaller specialization needs a new
positive closed proof and independent tests; this inventory intentionally does
not auto-approve it. No size saving or browser/physical certification is claimed.

## Next architecture boundary

Do not revive KVVFS/vtab deletion or low-yield reducer extraction without new
proof. SQLite remains 210,779 raw / 62,560 gzip in the current shared asset; even
removing that entire asset (which is not safe or authorized) would not close the
360,834 / 97,042 complete-worker gap.

The next source investigation is the `db-worker.ts` seed/panel/projection import
boundary (`packages/shell/src/shells/seed-panels.ts`, `seed.ts`, and
`packages/kernel/src/projection.ts`), followed by the large Store closure.
A pure-computation boundary needs a product/performance reason,
bounded schemas, worker-side recapture/freshness checks and real deletion of
duplicate production bytes. Moving bytes to another emitted asset alone cannot
close completeBrowser. Durable Store/catalog authority, final panel validation,
SQL and Merkle publication must stay in the DB worker. No such move is made in
this checkpoint; exact measurements and remaining gates are in the handoff.
