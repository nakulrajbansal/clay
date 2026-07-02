# 10 — Architecture Decision Records (ADR log)

Format: context -> decision -> alternatives -> consequences. Binding until
superseded by a new entry.

ADR-001 Client-first; records never on server.
  Alt: conventional SaaS store. Rejected: kills the trust story, adds
  compliance surface, and the whole category's wedge is data dignity.
  Consequence: sync is harder later (accepted; version log is event-shaped
  to keep the door open).

ADR-002 SQLite-WASM in OPFS over IndexedDB.
  Alt: IndexedDB + custom query layer; PGlite. Rejected: IndexedDB pushes
  query semantics into hand-rolled code the model must target; PGlite is
  heavier with no v1 payoff. Consequence: dedicated worker requirement;
  Safari OPFS quirks owned in week 1.

ADR-003 Constrained Query objects instead of SQL from panels.
  Alt: read-only SQL with a parser/allowlist. Rejected: parsing SQL for
  safety is a losing game; objects give static dependency extraction free.
  Consequence: expressiveness ceiling — mitigated by within_days-style ops
  and the rejection-log roadmap.

ADR-004 Vnode vocabulary + kernel components; no raw DOM/React in panels.
  Alt: sandboxed React, or sanitized HTML strings. Rejected: bigger attack
  and inconsistency surface; validation becomes heuristic. Consequence:
  some intents inexpressible in v1 (measured, drives v1.1).

ADR-005 iframes (opaque origin) over Workers/QuickJS-WASM for panels.
  Alt: Worker (no DOM -> needs a render protocol anyway); QuickJS (strong
  but heavy, slower iteration). Rejected for v1 on shippability.
  Consequence: ~1–3MB per iframe overhead; cap 20 panels (acceptable).

ADR-006 No destructive migration ops; hide-not-drop; mandatory inverses.
  Alt: allow drops with confirmation. Rejected: one bad drop ends trust;
  storage cost of retained columns is trivial at personal scale.
  Consequence: version log semantics stay information-preserving (enables
  the honest time slider).

ADR-007 Linear history, truncate-on-branch.
  Alt: branching/DAG. Rejected: UX and semantics cost explodes; personal
  apps rarely need branches. Consequence: one destructive-ish operation
  (truncation) exists, guarded by an explicit warning.

ADR-008 Whole-panel replacement, never patches, from the model.
  Alt: diff/patch output. Rejected: patch application failures are a whole
  failure class; panels are small. Consequence: slightly more output tokens
  (pennies).

ADR-009 Model sees schemas and intent, never rows.
  Alt: include sample rows for better generation. Rejected: breaks P2,
  invites prompt injection via data, grows context. Consequence: the model
  occasionally guesses formats wrong — mitigated by registry type detail
  and the repair round.

ADR-010 One repair round, then visible failure.
  Alt: agentic retry loops. Rejected: unbounded cost/latency, and silent
  struggle erodes trust more than honest failure. Consequence: first-pass
  quality is existential -> P0.1 exemplars + nightly gate.

ADR-011 Hosted proxy AND BYO key, both first-class from day one.
  Alt: BYO-only (no backend) or hosted-only. Rejected: BYO-only caps the
  audience; hosted-only weakens the trust anchor. Consequence: ~500-line
  backend maintained.

ADR-012 Panels communicate only via kernel-routed events.
  Alt: shared state object. Rejected: coupling + integrity risk.
  Consequence: FilterBar/Chart pairs need the event pattern (exemplar 6).

ADR-013 Two-layer plan validation: simplified schema at the API, full Zod
  client-side. (Decided in G1; entry back-filled per G26.)
  Alt: push the full MutationPlan schema into the structured-output
  grammar. Rejected: API grammar complexity caps can't hold nested
  Query/Condition/op constraints, and coupling the grammar to every schema
  change defeats caching. Consequence: the API guarantees parseability
  only; packages/schema (Zod) + Validator remain the sole correctness
  gate; mutation-plan-api.json is kept byte-stable.

ADR-014 Panels declare writes, not just reads (declared_writes).
  Context: doc 03 scoped declared_queries to reads while doc 06 checked
  "table access" per call — write access was unspecified (G22).
  Alt 1: writes unrestricted to any registered table. Rejected: violates
  least privilege; a buggy generated panel could corrupt unrelated tables.
  Alt 2: infer write tables from code statically without a declaration.
  Rejected: the manifest should be reviewable without executing code, and
  V4's declare-then-verify pattern already exists for reads.
  Consequence: PanelArtifact gains declared_writes (<= 4 tables); Bridge
  enforces at call time; V4 verifies write-call table literals against it;
  one more field the model must emit (taught by exemplar 5).
