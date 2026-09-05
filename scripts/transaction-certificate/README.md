# 001: OPFS attached-database atomicity

## Question

**Given** Chromium, `@sqlite.org/sqlite-wasm` 3.53.0-build1, the SAH-pool VFS, one main database, and two attached databases, **when** the owning worker is terminated after each SQL statement boundary in a three-database transaction, **then** reopen recovery must expose either all old values or all committed new values, never a mixed state, and every database must pass `integrity_check`.

## Why this is highest risk

A-F cannot claim atomic catalog plus app transitions from SQLite documentation alone. The certificate must exercise Clay's actual browser engine, SQLite-WASM build, VFS, journal mode, and attached topology. A passing spike permits a production certificate harness. A failure forces the colocated recovery-journal design.

## Method

- Vite serves an isolated origin and module worker.
- Each failpoint uses a fresh worker on one custom SAH pool.
- The worker opens a primary DB and attaches `sys` and `cat` DBs.
- The controller terminates the worker after `BEGIN`, each update, before `COMMIT`, and after returned `COMMIT`.
- A new worker reopens the same pool and reads all values plus each `integrity_check`.
- Three rounds run by default. Set `ROUNDS` for stress runs.

## Pass criteria

1. Pre-commit termination always reopens all-old.
2. Post-commit termination and normal completion always reopen all-new.
3. No mixed tuple occurs.
4. All three integrity checks return `ok`.
5. No browser console or page error occurs.

## Verdict: CORE MECHANISM VALIDATED

The initial stress run passed 180/180 cases on Chromium 149 with SQLite source
`4525003a53a7fc63ca75c59b22c79608659ca12f0131f52c18637f829977f20b`
and `delete` journal mode for all three databases. Run
`pnpm verify:transaction-core`; evidence is written to
`evidence/transaction-certificate/report.json`.

This is not the A/B release certificate yet. Production semantic hook coverage,
concurrency oracles, supported-runtime repetition, and kill coverage around the
native commit/durability boundary remain required.
