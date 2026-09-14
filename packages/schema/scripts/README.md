# Production standalone validators

`generate-standalone.mjs` compiles the existing, closed Zod authoring contracts
into ordinary ESM source under `src/standalone`. Production consumers import
`@clay/schema/standalone/<module>`; the original exports remain the development
and test oracle. The `.d.mts` facades retain the oracle's exact parsed types but
do not claim that a standalone parser implements Zod's fluent authoring API.

## Source and build boundary

`standalone-approved.json` pins the exact authoring files, their helper bodies,
and the installed Zod implementation used by the compiler. It is not runtime
user data or release evidence. A changed or new input fails before generation;
there is no automatic approval flag. A deliberate contract change must update
its tests, inspected source digest, and generated files together. The production
build runs `--check` and rejects stale generated files. Node, TypeScript,
esbuild, Zod, and the compiler stay outside the production runtime.
The allowed input set and resolved dependency identity are checked before any
manifest-directed read; extra, missing or path-escaping entries fail closed.

```text
node packages/schema/scripts/generate-standalone.mjs
node packages/schema/scripts/generate-standalone.mjs --check
```

The supported version-1 program consists only of scalar checks, closed object
modes, arrays/tuples/records, unions/discriminators, optional/nullable, pinned
refinements, empty-array/boolean defaults, the existing JSON recursion, and the
existing import ArrayBuffer predicate. The compiler rejects unknown definitions,
checks, custom maps, coercion, transforms, preprocessors, arbitrary defaults,
custom predicates, recursion and unsupported source statements. Original
refinement functions and their lexical helpers are emitted as readable static
JavaScript. Chained hooks use distinct source spans. Workflow-local schemas are
hoisted only after a closed free-name check. No runtime code generation, eval,
Function constructor, remote program, or executable model output is involved.

Closed object modes and positional limits avoid authoring API overhead. Repeated
inert program literals are emitted once in `programs.mjs`. Callback bodies,
lexical references, global/sticky patterns and exposed enum option arrays are
excluded from sharing. Whole construction IIFEs (not validation calls) carry PURE
annotations so unused schema arguments cannot retain unrelated domains in
esbuild or Rollup. Every pooled literal still counts in the frozen closures.

The interpreter accepts programs only from these source modules, never a worker
command or an archive. Programs do not grant SQL, storage, network, or mutation
capabilities. Existing descriptor capture, payload accounting, ClayError
adapters, request identity, authority fences, and final write checks are intact.
Direct parse tests intentionally match the oracle's observable getter/type
probes; this does not allow accessors past `captureStrictJson`.

## Verification

Schema differentials compare decisions, parsed data, issue paths/order and
serialized messages for every generated public validator, plus nested branches,
boundaries, defaults/refinements, Unicode, non-finite values, prototypes,
accessors, symbols, sparse arrays, and fatal/dirty union behavior. Full kernel
and WorkerClient suites exercise the actual production adapters. These are
executable tests, not a claim of exhaustive mathematical equivalence.

`scripts/schema-production-inventory.mjs` inventories value imports and factory
calls using the actual build's module membership, with source digests and
per-declaration policy locations. `--output` writes the development-only inventory
to `test-results/fix-batch/schema-production-inventory.json`. Build guards and
`scripts/standalone-module-check.mjs` reject authoring/Zod production modules and
duplicate interpreter assets. The existing bundle collectors are unchanged and
still count every generated validator and the complete interpreter closure.
