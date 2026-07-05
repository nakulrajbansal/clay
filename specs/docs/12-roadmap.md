# 12 — Product Roadmap (vision → shipped product)

The build plan (doc 09) took Clay from nothing to a working local app. This
doc charts the arc from there to the full vision. It is subordinate to the
five principles: any item that would break one is rejected or redesigned,
not shipped.

## The vision (restated)

One malleable personal application. A non-technical person owns a single app
whose **interface and features are reshaped through natural language**, while
their **data persists beneath every change**. No code, no schema migrations
by hand, no lock-in. You describe what you want; the app becomes it; and
every version of it is a projection over data you always own and can always
rewind, export, and carry away.

## The principles (the roadmap's guardrails, in priority order)

1. Data outlives interface.
2. Every change is reversible, atomically.
3. Generated code is untrusted code.
4. The model is invoked only at the moment of reshaping.
5. Preview before commit.

Every phase below names which principles/ADRs it leans on so the guardrails
stay visible as scope grows.

---

## Phase 0 — The malleable core (SHIPPED)

The MVP: the whole reshape loop working locally, data-safe, sandboxed.

- Kernel: SQLite-WASM store over OPFS, registry, MigrationEngine with
  inverses, VersionLog, QueryCompiler, ExpressionEngine (P1–P2).
- The mutation pipeline S0–S6: prompt assembly, model client (BYO), the
  Validator V1–V7, shadow dry-run, preview, atomic commit, hot swap (P5).
- Sandbox: opaque-origin iframes + CSP + Bridge; the hostile-panel corpus
  (P3).
- Trust surfaces: time slider + scrub + make-latest, panel error boundary +
  panel-scoped revert + repair, Data view + row-level undo, `.clay`
  export/import (P2, P1).
- Reach of the vocabulary: the 8 named components **plus composable
  primitives** (Box/Text/Bar/Scene, ADR-016) so panels tailor to novel
  requests — gantt, kanban, calendar, bespoke visuals.
- Observer suggestions; settings/status; the 25-intent regression runner;
  PB1–PB4 property tests; pipeline diagnostics for tuning.
- A one-click Windows launcher.

What Phase 0 is NOT yet: hosted (BYO key only), deployed, multi-app, or
operated against the launch gates. That is Phase 1.

---

## Phase 1 — Make it real (hosted, deployed, verifiably private)

Goal: anyone can use Clay **without bringing their own API key**, on the
web, and can *see* that their data never leaves their device. This is the
gap between "runs on my machine" and "a product." (ADR-011: hosted proxy
AND BYO, both first-class; today only BYO exists.)

1. **Hosted backend** (doc 07). A thin Hono proxy: `/mutations/plan` and
   `/mutations/repair` assemble the prompt server-side (reusing
   `@clay/mutation`) and call the model with a server-held key; records
   never cross the wire (B2, ADR-009). Server re-validates plans before
   returning (never relays malformed output).
   - First slice (buildable/testable now): the proxy with the key in server
     env, no auth — makes hosted mode work locally and centralizes the model
     request in one controllable place.
   - Then: magic-link auth, per-account quotas (atomic in Postgres), the
     `/me` meter, quota-exhaustion UX (G10).
2. **Deploy**. Vercel (static shell + worker assets) + backend on Fly.io /
   Cloudflare Workers + Neon Postgres. `.env.example`, no secrets in repo.
3. **Landing page** with the live DevTools privacy-verification section: a
   visitor watches the network tab during real use and sees zero record
   traffic (P1–P4 backed by CI, not adjectives).
4. **Operate the launch gates** (doc 08 §7): regression nightly (L1),
   hostile corpus in CI (L2), PB at 10k (L3), a privacy E2E under Playwright
   (L4), and a first unassisted-stranger test (L5).

Honors: ADR-011, ADR-001/009 (data never server-side), P1–P5.

---

## Phase 2 — Make it deep (more capable, self-improving)

Goal: the app gets meaningfully more powerful the more you use it, and the
vocabulary grows where users actually hit walls — measured, not guessed.

1. **Multi-app** (G4): up to 3 apps, each its own OPFS subdirectory; app
   switcher in the header; per-account quota; per-app export. Turns "one
   app forever" into "a small set of personal tools" (work + personal).
2. **Quality dashboard** (doc 05 §5, doc 09 post-launch): surface first-pass
   commit rate, repair-save rate, clarify rate, and **discard rate by diff
   kind** — the last is the signal for *which reshape types disappoint*.
   Drives prompt and vocabulary work.
3. **Vocabulary v1.1**, driven by the validator-rejection log and discard
   metrics: the next-most-requested components and migration ops (the
   composable primitives are the start of this). Each ships with fixtures
   and an ADR, per the constitution.
4. **Prompt tuning loop**: use the diagnostics to raise first-pass quality
   on the long tail (novel layouts, compound intents), behind the nightly
   gate (>5pp drop blocks a prompt change).
5. **Observer maturity**: more heuristics (token-promotion, repeated-filter
   shipped), better-timed suggestions, dismissal learning.

Honors: P4 (model only at reshaping — the dashboard/observer are local
analytics, not extra model calls), P2, the constitution's ADR discipline.

---

## Phase 3 — Make it reach (beyond one device, one moment)

Goal: your app follows you, and you can share what you've built — without
surrendering data ownership.

1. **Sync** (the version log is event-shaped precisely to keep this door
   open, ADR-001). End-to-end-encrypted sync of the `.clay` event stream so
   the same app appears on a second device. Records still never readable by
   the operator (the Phase-1 privacy guarantee holds).
2. **Read-only sharing / publish**: hand someone a link to a snapshot of an
   app or a single panel (rendered, no write access). A trust-preserving
   subset of "collaboration" that doesn't require the branching rethink.
3. **Mobile-responsive shell** (v1 deferred it): the panel regions and rail
   reflow; touch targets meet the a11y floor (G12).
4. **Careful external reads**: opt-in, sandbox-preserving read connectors
   (e.g. import a calendar as rows) — never a panel network path; always a
   kernel-mediated, reviewable, revocable bridge.

Honors: P1/P3 (sync and connectors must not weaken the untrusted-code or
data-dignity guarantees), P2.

---

## Phase 4 — Make it an ecosystem (the long horizon)

The most ambitious, most deliberately deferred — each needs a design pass
of its own, and some reopen "noes" the MVP closed on purpose.

1. **Templates / starter gallery**: shareable app definitions (schema +
   panels) beyond the three seed shells — the honest, safe version of a
   "marketplace" (every imported panel is re-validated, G15).
2. **Multi-user collaboration** on one app: the big one. Requires revisiting
   linear history (ADR-007) toward CRDT/branching, and a permission model.
   A v2 architecture question, not a feature toggle.
3. **Automations**: "when a row's due date passes, mark it late" — a safe,
   declarative rule vocabulary evaluated by the kernel (never generated
   code with ambient authority).

These stay on the horizon until Phases 1–3 prove the core with real users.

---

## Reclassifying the pre-decided "noes" (doc 01 §3, G17)

| No (v1) | Status on this roadmap |
|---|---|
| Multi-user | Phase 4 (needs a history/permission redesign) |
| Branching history | Phase 4 (coupled to multi-user) |
| Raw HTML panels | **Permanent no** (breaks P3; primitives are the answer) |
| CSV import | Phase 3 as a kernel-mediated connector, not a panel path |
| External integrations | Phase 3, read-only + sandbox-preserving |
| Mobile polish | Phase 3 |
| i18n | Phase 3+ (post-traction) |
| Offline mutation queueing | Deferred; offline USE already works |
| Panel marketplace | Phase 4 as re-validated templates |
| Code export | **Permanent no** (`.clay` data export is the ownership story) |

---

## Immediate next step

Phase 1.1 — the **hosted backend proxy**, built as a runnable local server
first (key in env, no auth), so hosted mode works without a browser-stored
key and the model request lives in one controllable place. Auth, quotas,
and deploy configs follow. This is the one piece of the original four-week
plan still unbuilt, and it makes ADR-011's "hosted, first-class" promise
true.
