# Owned starter computation (development checkpoint)

This is an implementation/optimization checkpoint, not browser or release
certification. The only new pure task is **starter fragment construction**.
Read-only export and Daily projection work has not moved. The DB worker remains
the sole Store/catalog/SQLite/native-recovery/write authority.

## Boundary

1. The DB worker captures the existing mutation request ID, selected target
   (app, generation, lineage, revision, digest) and catalog generation.
2. `SeedComputeClient` spawns an owned module worker and transfers a newly created
   private MessagePort. The ambient worker channel accepts only this one setup.
   One job runs per worker; its random nonce is ephemeral, not a durable ID.
3. Both ends capture descriptor-safe bounded JSON and parse the closed generated
   standalone request/reply schema. The pure task accepts a finite starter enum,
   source identity and nonce, **not** SQL, a Store, a query handle, arbitrary code,
   a provider, a fence, a receipt or a request-journal capability.
4. The DB-side client verifies the exact source/nonce echo, UTF-8 byte count,
   original-order wire SHA-256 and canonical SHA-256 against
   `src/worker/seed-manifest.json` before returning a
   candidate. The manifest is versioned and source-bound to the starter definitions.
   `node scripts/seed-manifest.mjs --check` never updates it; `--candidate` prints
   data for an explicit reviewed refresh. The production build runs the check.
5. `ProductionMutationCoordinator.execute` recaptures the optional computed
   source before queueing. Only `starter.seed` may carry it. The original selected
   target/catalog generation is checked **inside** the serial authority queue,
   before existing fingerprint/reservation/shadow/fence/mutation/publication/
   receipt/readback processing. No new route or arbitrary Store command exists.
6. Error, timeout, duplicate/invalid response or teardown closes the owned ports,
   terminates the CPU worker and rejects the task. No durable invocation exists
   at this stage. The UI's existing retained mutation ID/payload is unchanged.
   A subsequent attempt uses a fresh CPU worker; durable seed retries still
   reconcile the original authority receipt. Late CPU replies have no write path.

`pure-compute-boundary.mjs` guards actual production imports and executable AST
capabilities; embedded panel strings are data, not code executed in this worker.
The build/module checks deny DB/catalog/Store/network/storage/provider imports
and require the DB closure not to contain the starter implementation. Standalone
validation is shared; no authoring Zod/runtime code generation is introduced.
The pinned SQLite initializer, WASM, SAHPool and native journal machinery are
unchanged. The module checker supplements, and does not modify, bundle collectors.

## Exact source compaction and tests

Starter row matrices eliminate repeated field-name literals. Visible static
`panelCode`/`watchedPanelCode` primitives eliminate repeated panel wrappers.
There is no compressed executable asset, network asset or code evaluator.
Independent frozen pre-refactor seed and panel sources live under `test/oracles/`.
Their hashes are pinned. All sixteen output bundles, panel strings, ordering,
canonical bytes and manifest hashes are compared against those originals.

Focused tests cover malformed/prototype/accessor/symbol inputs, same-length
tampering, unknown starters, wrong/stale source, wrong nonce, duplicate replies,
oversize, worker failure, timeout and teardown. Real WorkerClient/DB-worker tests
exercise source changes during delayed computation, failure/restart, lost durable
responses and reload/replay. The fixture substitutes only owned message transport
and database acquisition; it is not a physical browser certificate.

## Remaining architecture work

The first boundary reduced the DB closure but increased complete-browser bytes.
Subsequent source compaction reduced that overhead, **not enough to close the
aggregate browser or worker limits**. Exact current measurements and real test
results are in `CODEX_DEVELOPMENT_HANDOFF.md`; no savings are inferred from source
line counts or moving assets between realms.

The checked `store-reachability.json` is a conservative declaration-resolved
method/helper inventory with explicit unresolved capability flows. It records
captured/imported aliases, physical module membership and source hashes. Unknown
computed properties, reflection, erased aliases and unresolved callbacks block
omissions. `node scripts/store-reachability.mjs --check` checks inventory freshness,
not permission to remove methods. No production Store optimizer/plugin is installed.
Returned/held Store capabilities and private WeakMap callback flows remain open
proof edges. The few unreferenced methods are not a budget-sized deletion.

A future projection move must separately capture bounded immutable rows and
semantic metadata under the existing projection snapshot checks, validate its
closed result and original source, preserve cancellation/completeness/redaction/
CSV semantics, and retain all final action CAS checks in authority. Merely moving
`projection.ts` or Daily CAS validation is not an authorized optimization.
