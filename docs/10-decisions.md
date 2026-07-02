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
