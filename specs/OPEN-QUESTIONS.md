# Open questions (running log; Claude Code appends here per CLAUDE.md)
- none at package creation

## W1 kernel implementation (2026-07-02) — narrow interpretations, TODO(spec)
- Q14 Enum CHECK constraints are NOT emitted in DDL (doc 04 §2 says
  enum->TEXT + CHECK(list)): add_enum_value cannot alter a CHECK without a
  table rebuild, which would contradict "migrations trivial". Enum
  membership is kernel-validated on every write instead. Candidate
  correction to doc 04 §2.
- Q15 rename_column is REJECTED when any computed expression in the table
  references the renamed column. The alternative (rewriting exprs via the
  I4 rename-map, like panel queries per G16) needs a spec decision.
- Q16 Computed columns are usable in select/where/orderBy (evaluated
  post-SQL, exemplar 3 works) but REJECTED in groupBy/aggregate (E_TYPE).
- Q17 set_required supports required:true only, so unset_required is a
  faithful inverse (required:false forward would not round-trip — the
  vocabulary has no "restore previous flag" op). Also: set_required
  without default_for_existing is allowed even when null rows exist;
  enforcement is prospective (inserts) — decide if it should scan.

## P0 verification pass (2026-07-02) — exemplars/schema/shells vs docs 03-06

STATUS 2026-07-02: ALL RESOLVED. Q1→G18, Q2→G19, Q3→G20, Q4→G21,
Q5→G22+ADR-014, Q6→G23, Q7→G24, Q8→G25, Q9/Q11/Q12/Q13→G26, Q10→G26
(layout applied: specs/ + packages/schema per doc 02 §9). ADR-013
back-filled into doc 10. Original findings kept below for the record.

### Contradictions (need a decision / ADR or gap resolution)
- Q1 Exemplar 7 fails the Zod MutationPlan schema: `summary: ""` violates
  `z.string().min(1)`. Doc 05 §2 says a clarifying plan has "ALL other
  fields null", but exemplar 7 uses ""/[]/0.3 and the schema requires
  non-null. Three-way disagreement (doc 05 wording vs schema/index.ts vs
  exemplar 7). Narrowest fix: allow empty summary only when
  clarifying_question is set, and soften doc 05 wording.
- Q2 Exemplar coverage diverges from the doc 05 §3(5) list: no exemplar
  uses `create_computed` (03-computed-and-strip.md is named for it but only
  adds a plain date column); no exemplar exercises `remove_panels`
  (exemplar 9 hides a FIELD); "low-confidence assumption" is not clearly
  covered (exemplar 10 is out-of-scope handling, which the doc list omits).
- Q3 `compute.eval` is sync in doc 03 §4 but appears in BridgeCall
  (schema/index.ts), which is async postMessage. Either the expression
  evaluator ships inside the PanelRuntime bootstrap (drop it from
  BridgeCall) or eval becomes async (doc 03 change).
- Q4 Boot message mismatch: doc 06 §3 boot carries `tokens`;
  BridgePush.boot in schema/index.ts has only {code, panelId, apiVersion}.
  Also unclear where the clay.meta.schema snapshot is delivered (neither
  shape includes it).
- Q5 Write-access scoping is ambiguous: exemplar 5 inserts into
  `appointments` while its declared_queries cover only `clients`. Doc 03
  scopes declared_queries to *queries*; doc 06 §3 says "table access
  checked against the panel's declared_queries" per call. If writes are
  checked, exemplar 5 is invalid; if not, panels have unscoped write access.
- Q6 Backfill inverses: I2 (doc 04 §4) demands an op-by-op mirror, but
  exemplar 2 has 2 forward ops (add_column + backfill) vs 1 inverse, and
  InverseOp has no op that reverses a backfill of a PRE-EXISTING column.
  Also the Zod backfill op does not enforce "value XOR expr" (doc 04 says
  `value | expr`); a backfill with neither passes.
- Q7 V7 (diff honesty) taken literally fails exemplar 2: the `backfill` op
  has no user_facing_diff line. Decide whether V7 counts backfill as
  covered by its paired add_column/add_status line.

### Spec gaps (exemplars are the de facto spec; docs silent)
- Q8 Doc 03 never defines FieldSpec for Form; exemplar 5 uses
  {name, label, kind, options, fromSchema} — `fromSchema` and per-field
  `kind` are undocumented. FilterBar in exemplar 6 likewise adds `options`
  to the filter spec, absent from the doc 03 contract.
- Q9 BridgeCall has `db.unwatch` but no `events.off`, yet doc 03 says
  events.on returns an Unsubscribe.

### Housekeeping (no design decision needed)
- Q10 Repo layout: README "How to start" and CLAUDE.md reference
  `specs/docs/...`, but the package is committed at repo root. Either move
  docs/exemplars/schema/shells/tests/prompt under specs/ or fix the paths.
- Q11 Doc 05 §3 names the prompt file `prompt/v1.md`; the actual file is
  `prompt/system-v1.md` (README agrees with the latter).
- Q12 schema/index.ts uses `z.any()` (backfill.value, default_for_existing,
  Bridge args/result/rows/payload) — CLAUDE.md bans `any` in schema
  packages; z.unknown() or a recursive Json schema would comply.
- Q13 Shells "log" and "dashboard" have a column named `on` — a SQLite
  keyword; MigrationEngine must quote identifiers (hazard, not a violation).

### Verified clean
- Migration vocabulary (forward + kernel-only inverse ops) matches doc 04 §4
  one-to-one; I5 encoded as a refine; V6 budgets (64KB code, 8 panels,
  5000 limit) encoded.
- Query/Condition ops and bounds match doc 03 §1 exactly, including the
  {"$var": true} placeholder for V4.
- mutation-plan-api.json is a faithful simplification of the Zod schema
  (G1/ADR-013): same fields, same required set, enums only where cheap.
- Exemplar 10's intentional V4 violation (missing clients query) is present
  and documented in its NOTE, as the README promises.
- Shell registries, panel ids, regions, and column types all validate
  against ColumnSpec/PanelId; exemplar panel ids and queries (except the
  intentional exemplar-10 case) match their declared_queries per V4.
