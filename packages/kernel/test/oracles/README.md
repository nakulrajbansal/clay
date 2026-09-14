# AuthorityGraph pre-refactor oracles

## Whole Store oracle (samples / reducer continuation)

`store.ts` was captured from `a8aa18742783cf358e6313f387923bdd63d9c110`
before any Store reducer changes. Only the provenance header, relocated relative
imports and test-only `rawArchiveSchemaIssuesOracle` export differ. Its
LF-normalized SHA-256 is
`80ab194f69db122898dc2d6853e8f47f285a775ac9490aff622f62e09efb4fd7`;
`store-reducers.test.ts` pins it. Do not update this oracle to fit production.

`store-reducer-fixture.ts` opens independent old/new Store classes on separately
cloned, guarded synthetic databases. The old Store's private weak-map attachment
executor and all reducer bodies remain original. The fixture compares exact
user/system database exports, DDL/rows, semantic registry/history, canonical
enumeration and independent Merkle materialization. Store reducers do not publish
catalog receipts; their catalog/authority behavior is instead covered by the
coordinator differential and WorkerClient integration packets. Faults pass
through the real guard/transaction implementation and throw at selected physical
writes or durable receipt readback. Reopen reconstructs each original/current
Store without changing the connection's authority.

The samples differential remains in `production-transition.test.ts` and uses the
older frozen coordinator on independent catalog/user/system copies, including
reservation/invocation/publication/readback faults and terminal recovery. The
samples helpers themselves were relocated without changing their algorithms.

## Transition coordinator oracle (Phase 3A)

`production-mutation-coordinator.ts` and `production-core-routes.ts` were captured
from `f53ac67eb3541b56c5d6bedadc0acbfd78563c64` before production edits. Relative
imports were relocated; the old coordinator imports the old core dispatcher,
not the new descriptor/interpreter. Its private capture function is additionally
exported for test-only comparison. Bodies, error adapters, no-op/replay rules,
reservation/publication ordering and fault seams remain unchanged. Their hashes
are pinned independently in `production-transition-modules.test.mjs`.

`production-transition.test.ts` clones the complete synthetic user, system and
catalog schemas/rows into separate owned in-memory connections, then wraps each
in the real LiveWriteGuard. It compares returned values and error code/message,
every physical row and DDL, user/system exports, canonical leaves, Merkle and
catalog/receipt state. Fixed synthetic randomness and clock make byte comparisons
meaningful; the test yields the real event loop so long WASM runs do not starve
Vitest RPC. Faults are injected through the guarded connection, not through a
permissive driver or replacement transaction implementation. Reopen goes through
unchanged ProductionStoreAuthority recovery on independent physical copies.

This is deterministic development parity, not OPFS/native/browser certification.
The frozen oracles and SQL fixture copier are never production runtime inputs.

## AuthorityGraph readers (Phase 2)

The two TypeScript modules were captured from
`28db0b9ed11eb6e169325d4cfc9250bdf83e1414` before production switched to the graph.
Relative imports were relocated, a provenance comment was added, and the private
reader functions were additionally exported for tests. Their bodies and public
catalog/archive behavior are unchanged. The module test pins LF-normalized hashes;
do not edit these readers to make a new implementation pass a differential.

These are **test-only source snapshots**, not application data or release evidence.
They contain no real keys or owner records. Their fixture builders use owned
in-memory SQLite and synthetic authenticated archives. The production module
guard rejects any emitted kernel test/oracle module.

`authority-graph.test.ts` makes independent physical catalog copies, preserving
the original schema/rows before corrupting each copy, and compares old/new public
results. Archive comparisons authenticate separate byte copies before the normal
member, schema, relationship and canonical-state paths. Valid-state assertions
and explicit rejection assertions prevent a pair of failing implementations
from being counted as successful parity.

The pure graph does not replace the adapters:

| Boundary | Preserved outside the graph |
| --- | --- |
| Live catalog | DDL, object allowlists, row codecs/cardinality, tombstones, closed pending jobs, storage/manifest relationships, recovery fencing, legacy migration |
| Archive | Authentication, ZIP/member/size/checksum/canonical/Merkle checks, schema-version compatibility, response digest/mirror and quarantine checks |
| Specialized receipts | Shared retention/reattestation validators and private owner-history proof; distinct live/archive lifecycle result/provenance policies |

Graph stages are called in the adapters' original order. In particular archive
identity/lifecycle checks precede generation and chain checks, whereas live
reservation authority is checked before chains. The live public catch boundary
is retained; archive rejection reasons and priority are compared explicitly.
