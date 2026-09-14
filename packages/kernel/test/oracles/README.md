# AuthorityGraph pre-refactor oracles

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
