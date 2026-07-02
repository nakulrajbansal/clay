# Clay: Technical Design Document

**Product**: A malleable personal application. The user owns one app whose interface and features are living artifacts, reshaped through natural language, while their data persists beneath every change.

**Status**: Draft v1 for solo build, 4 weeks part-time
**Author**: Nakul Bansal
**Reviewers**: (self, plus external feedback post-MVP)

---

## 1. Vision and design principles

Software today freezes its author's guesses at compile time. Clay inverts this: the shipped product is a kernel (data layer, safety rails, version control) and the application layer is generated, per user, on demand, and persistently. The user is not a prompt engineer building an app once; they are an owner whose app accretes fit over months.

Five principles govern every design decision below, in priority order:

1. **Data outlives interface.** No mutation, however botched, may corrupt or lose user records. The data plane is architecturally incapable of being damaged by the UI plane.
2. **Every change is reversible, atomically.** Code, schema, and data roll back together as one unit. Undo is total or it is not offered.
3. **Generated code is untrusted code.** It runs with capabilities, not permissions. The kernel grants a narrow API; everything else is unreachable by construction.
4. **The model is invoked only at the moment of reshaping.** Daily use of the app requires zero API calls, works offline, and costs nothing.
5. **Preview before commit.** No mutation lands silently. The user sees a plain-English diff and a live preview, then chooses.

Non-goals for v1: multi-user collaboration, mobile clients, plugin marketplace, arbitrary external integrations, self-hosted enterprise mode. Each is a coherent v2+ direction; all are scope death in a 4-week window.

---

## 2. System overview

Clay is a client-first web application. All user data and all generated artifacts live in the browser. A thin backend exists only for auth, mutation-request proxying to the model, and (later) sync.

```
+--------------------------------------------------------------+
|  Browser (the product)                                       |
|                                                              |
|  +----------------------+   +------------------------------+ |
|  |  Shell (trusted)     |   |  Panel sandboxes (untrusted) | |
|  |  - layout chrome     |   |  - generated components      | |
|  |  - conversation UI   |   |  - iframe or Worker isolate  | |
|  |  - preview/diff UI   |   |  - sees ONLY the Kernel API  | |
|  |  - time slider       |   +---------------^--------------+ |
|  +----------+-----------+                   | postMessage    |
|             |                               | bridge         |
|  +----------v-------------------------------+--------------+ |
|  |  Kernel (trusted)                                        | |
|  |  - Store: SQLite (WASM) in OPFS                          | |
|  |  - Schema registry + migration engine                    | |
|  |  - Capability bridge (db/ui/events API)                  | |
|  |  - Version log (commits: code + schema + data deltas)    | |
|  |  - Validator (static checks on generated code)           | |
|  |  - Observer (usage patterns -> proactive suggestions)    | |
|  +----------------------------+-----------------------------+ |
|                               |                               |
+-------------------------------+------------------------------+
                                | HTTPS (mutation requests only)
                +---------------v----------------+
                |  Thin backend (Node/Hono)      |
                |  - auth (email magic link)     |
                |  - model proxy w/ rate limits  |
                |  - BYO-key mode bypasses this  |
                +---------------+----------------+
                                |
                        Anthropic API (Claude)
```

The critical boundary is between the **Shell + Kernel** (code you wrote, trusted, versioned in your repo) and **Panels** (code the model wrote at runtime, untrusted forever, versioned in the user's local commit log).

---

## 3. Data plane

### 3.1 Store

SQLite compiled to WASM (the official `sqlite-wasm` build) persisted in the Origin Private File System (OPFS). Rationale over IndexedDB-direct: real SQL gives generated code a familiar, well-documented query target; transactions give atomic migration + data changes; OPFS gives durable, fast, synchronous-access-worker storage. The database runs inside a dedicated Worker; all access is message-based, which conveniently matches the sandbox bridge design.

Two databases, deliberately separated:

- `user.db` — the user's records. Tables here are created only by the migration engine, never by generated code directly.
- `system.db` — Clay's own bookkeeping: the version log, panel artifact blobs, schema registry, usage observations, settings.

### 3.2 Schema registry

Every user table is described by a registry entry (in `system.db`), which is the single source of truth the model sees:

```json
{
  "table": "projects",
  "version": 6,
  "columns": [
    {"name": "id", "type": "uuid", "pk": true},
    {"name": "name", "type": "text", "required": true},
    {"name": "owner", "type": "text"},
    {"name": "status", "type": "enum", "values": ["green","amber","red"]},
    {"name": "health_score", "type": "computed",
     "expr": "100 - 10*slipped_milestones - 5*open_risks"}
  ],
  "created_by": "mutation:0009",
  "row_count_hint": 42
}
```

Computed columns are evaluated by the kernel, not stored, and their expressions live in a small safe expression language (see 6.3), not arbitrary JS.

### 3.3 Migration engine

Generated mutations never emit raw DDL. They emit **migration plans** in a constrained JSON vocabulary the kernel executes:

```json
{
  "migration_id": "m_0012",
  "operations": [
    {"op": "add_column", "table": "clients", "column":
      {"name": "vaccine_expiry", "type": "date"}},
    {"op": "backfill", "table": "clients", "column": "vaccine_expiry",
      "value": null},
    {"op": "add_index", "table": "clients", "column": "vaccine_expiry"}
  ],
  "inverse": [
    {"op": "drop_column", "table": "clients", "column": "vaccine_expiry"}
  ]
}
```

Allowed ops for v1: `create_table`, `add_column`, `rename_column`, `add_enum_value`, `add_index`, `backfill`, `create_computed`. Explicitly disallowed in v1: `drop_table`, `drop_column` as user-facing generated ops (they exist only as kernel-generated inverses, and "deletions" are soft: the column is hidden and retained). This single decision eliminates the entire class of "the model destroyed my data" failures.

Every migration must ship its inverse. The kernel validates the inverse actually reverses the forward plan (structural check) before executing anything. Migrations run inside one SQLite transaction with the data backfill.

---

## 4. The Kernel API (the contract generated code programs against)

This is the load-bearing wall of the whole product. Generated panels receive exactly one global, `clay`, injected into their sandbox. Nothing else: no `fetch`, no `window.top`, no `document` beyond their own shadow root, no storage APIs.

### 4.1 Surface

```ts
interface ClayAPI {
  db: {
    // Read: constrained query builder, no raw SQL from panels
    query(q: Query): Promise<Row[]>;
    // Write: row-level ops only, always validated against registry
    insert(table: string, row: Partial<Row>): Promise<Row>;
    update(table: string, id: string, patch: Partial<Row>): Promise<Row>;
    softDelete(table: string, id: string): Promise<void>;
    // Reactive: re-runs query when underlying data changes
    watch(q: Query, cb: (rows: Row[]) => void): Unsubscribe;
  };

  ui: {
    // The panel's only rendering entry point
    render(vnode: VNode): void;
    // Design tokens (colors, spacing) so generated UI matches the shell
    tokens: DesignTokens;
    toast(msg: string, kind?: "info" | "success" | "warning"): void;
    confirm(msg: string): Promise<boolean>;
  };

  events: {
    emit(name: string, payload: Json): void;       // panel-to-panel, via kernel
    on(name: string, cb: (payload: Json) => void): Unsubscribe;
  };

  compute: {
    // Safe expression evaluation (same language as computed columns)
    eval(expr: string, scope: Record<string, number | string>): number | string;
    now(): IsoDateString;
  };

  meta: {
    schema: ReadonlyRegistry;   // what tables/columns exist
    panelId: string;
    version: number;            // app version this panel belongs to
  };
}
```

### 4.2 The Query type

Panels do not write SQL. They construct a serializable query object:

```ts
type Query = {
  from: string;
  select?: string[];                    // default: all registered columns
  where?: Condition[];                  // field/op/value triples, AND-composed
  orderBy?: {field: string; dir: "asc" | "desc"}[];
  groupBy?: string[];
  aggregate?: {fn: "count"|"sum"|"avg"|"min"|"max"; field: string; as: string}[];
  limit?: number;                       // kernel caps at 5,000
};
```

The kernel compiles this to SQL with bound parameters. This closes off SQL injection, runaway joins, and cross-table access the panel wasn't granted, and it makes every panel's data dependencies statically inspectable, which the versioning and suggestion systems both exploit.

### 4.3 Rendering model

Panels render through a restricted virtual-DOM vocabulary (a whitelisted subset of HTML elements plus a small set of kernel-provided components: `Table`, `Chart`, `MetricCard`, `Badge`, `Form`, `Button`, `Input`, `Select`, `DatePicker`). Charts are kernel components wrapping a bundled chart library; generated code declares chart specs, it does not draw. Rationale: dramatically higher visual consistency, far smaller attack surface than arbitrary DOM, and much easier static validation. Escape hatch (`ui.html()` for raw markup, sanitized) is deliberately deferred to v2 after real-world pressure proves which elements are missing.

Each panel executes inside a sandboxed iframe (`sandbox="allow-scripts"`, unique opaque origin, strict CSP: no network, no forms, no top navigation). The `clay` bridge crosses via `postMessage` with structured-clone payloads. Workers were considered (cheaper), but iframes give free DOM isolation for rendering and the per-panel count is small (< 20), so the overhead is acceptable.

---

## 5. The mutation pipeline

The end-to-end path from a user sentence to a permanent change. Every stage can reject and return the request to the previous stage with a reason.

```
user intent (natural language)
   |
   v
[1] Context assembly (kernel, local)
   |   schema registry + panel manifest + last N mutations
   |   + the user's sentence. NO user row data is included.
   v
[2] Plan generation (Claude, remote)
   |   model returns a MutationPlan: migration plan (3.3) +
   |   panel artifacts (code) + plain-English summary
   v
[3] Static validation (kernel, local)
   |   parse, lint, capability scan, query extraction,
   |   migration/inverse structural check
   v
[4] Dry-run in shadow sandbox (kernel, local)
   |   panel boots against a COPY of user.db (SQLite backup API),
   |   migration applied to the copy, render smoke-test,
   |   runtime errors caught here
   v
[5] Preview (user)
   |   live preview panel + plain-English diff card
   |   ("Adding field X / changing panel Y / your data: untouched")
   v
[6] Commit (kernel, local, atomic)
       version log entry: {migration, inverse, panel blobs,
       summary, parent_version}; migration applied to real DB;
       panel hot-swapped into the shell
```

### 5.1 The MutationPlan format

The model's entire output is one JSON document. Constraining the model to a schema (via tool-use / structured output) rather than freeform code files is what makes stages 3 and 4 tractable:

```json
{
  "summary": "Adds a health score to projects and a needs-attention strip",
  "user_facing_diff": [
    {"kind": "add_field", "detail": "health_score on projects (computed)"},
    {"kind": "change_panel", "detail": "Project table gains a Health column"},
    {"kind": "add_panel", "detail": "Needs-attention strip, pinned to top"}
  ],
  "migration": { "...": "see 3.3" },
  "panels": [
    {
      "panel_id": "needs_attention_strip",
      "placement": {"region": "top", "order": 0},
      "code": "export default function(clay){ ... }",
      "declared_queries": [ {"from": "projects", "where": [ ... ]} ]
    }
  ],
  "confidence": 0.86,
  "clarifying_question": null
}
```

If the model's confidence is low or the intent is ambiguous ("track my stuff better"), it returns `clarifying_question` instead of a plan, and the shell relays it. One question maximum per request; beyond that, the model must make a reasonable choice and say what it assumed in the summary.

### 5.2 Static validation (stage 3)

Checks, in order, all local and fast:

1. **Parse**: code must parse as an ES module with a single default export of the expected signature.
2. **Capability scan**: AST walk rejecting any reference to `fetch`, `XMLHttpRequest`, `WebSocket`, `import`, `eval`, `Function`, `window`, `document`, `localStorage`, `indexedDB`, `navigator`, dynamic property access on the `clay` object (`clay[x]`), and `postMessage`. The sandbox already blocks these; the scan exists so failures are caught before execution with a good error, and as defense in depth.
3. **Query consistency**: every `clay.db.query/watch` call site must use a query object matching one in `declared_queries` (structural match). This makes panel data-dependencies honest and machine-readable.
4. **Migration check**: every op in the allowed vocabulary; inverse structurally reverses forward; referenced tables/columns exist in the registry.
5. **Budget**: code size < 64KB per panel, < 8 panels touched per mutation.

### 5.3 Failure and self-repair

If stage 4 (dry-run) throws, the kernel does one automatic repair round: the error, the offending code, and the original intent go back to the model with a "fix this" instruction. One round only. If it fails again, the user sees "That change didn't work; here's what I tried" with the summary, and nothing is committed. Silent retry loops burn money and trust; a visible, bounded failure preserves both.

Runtime errors in committed panels (they will happen: data drifts into shapes the panel didn't anticipate) are caught by a per-panel error boundary. The panel is replaced by a small card: "This panel hit an error. [Repair] [Roll back this panel] [Dismiss]". Repair triggers the same one-round fix flow with the runtime error attached.

---

## 6. Versioning and time travel

### 6.1 Commit model

The version log in `system.db` is a linear chain (v1 deliberately has no branches):

```
commit {
  version: 14,
  parent: 13,
  created_at, 
  intent_text: "add a health score...",
  summary, user_facing_diff,
  migration, inverse,
  panel_blobs: {panel_id -> code, placement},
  panel_tombstones: [panel_ids removed at this version]
}
```

Panels are stored whole per version they change in (they are small); no diffing needed. The full app state at version N is: base schema + fold of migrations 1..N + latest blob of each live panel at N.

### 6.2 Rollback semantics

Dragging the time slider to version K executes, in one transaction: inverse migrations N..K+1 in reverse order, then panel set restored to K's manifest. Because v1 migrations never destroy data (soft deletes, retained hidden columns), inverses are always information-preserving, so rollback then roll-forward returns you to an identical state. Data *rows* added between K and N are retained (they are user records, principle 1); if they reference columns that don't exist at K, those cells are simply not visible at K and reappear on roll-forward.

Rolling back and then making a new mutation truncates the log above K (linear history). The shell warns once: "This will discard versions 15-17."

### 6.3 The safe expression language

Computed columns and `clay.compute.eval` share one tiny language: arithmetic, comparisons, boolean ops, field references, and a fixed function set (`min`, `max`, `abs`, `round`, `days_between`, `coalesce`, `len`). Implemented as a ~200-line Pratt parser + evaluator in the kernel. No property access, no calls beyond the whitelist, no assignment. This is boring on purpose; boring is the point.

---

## 7. The observer (proactive suggestions)

The kernel logs coarse usage events locally (panel views, manual edits, repeated values in free-text fields, sort/filter interactions). A weekly local job runs cheap heuristics:

- The same token appears in a free-text/notes field on >= N records -> suggest promoting to an enum status.
- A field is manually recalculated (user edits follow a consistent arithmetic pattern) -> suggest a computed column.
- A panel hasn't been viewed in 30 days -> suggest archiving it.
- A filter is applied to the same panel >= 5 times -> suggest a dedicated filtered view.

Heuristic hits become suggestion cards in the conversation panel (blue card in the mockup). Accepting one enters the normal mutation pipeline at stage 1 with a kernel-composed intent. No model calls happen during observation; the model is only invoked if the user accepts. Suggestions are capped at one visible at a time and dismissals are remembered. An over-eager assistant is the fastest way to make malleability feel like clippy.

---

## 8. Model layer

### 8.1 Access modes

- **Hosted (default)**: shell -> Clay backend -> Anthropic API. Backend holds the key, enforces per-user rate limits and monthly mutation quotas (free: 20/month; paid: unlimited). 
- **BYO key**: shell -> Anthropic API directly from the browser; key stored in `system.db`, never sent to Clay's backend. Unlimited, free to operate.

Identical request/response format in both modes; a single flag switches the endpoint.

### 8.2 Prompt construction

System prompt (static): the ClayAPI contract, the MutationPlan JSON schema, the rendering component vocabulary, the migration op vocabulary, ten curated few-shot examples spanning add-field, new-panel, computed-column, chart, and form mutations, and hard rules (no destructive ops, ship inverses, one clarifying question max, cite assumptions in summary).

Per-request context (dynamic, assembled locally): full schema registry, panel manifest (ids, placements, declared queries, NOT panel code except panels being modified), the last 5 mutation summaries, and the user's sentence. Note what is absent: user row data. The model never sees records, only shapes. This keeps the privacy story honest in hosted mode and keeps context small (typically < 6K tokens in, < 4K out).

Model: Claude Sonnet class for standard mutations; escalate to Opus class only on repair rounds (empirically where the extra capability pays). Temperature low. Structured output enforced.

### 8.3 Cost envelope

At ~10K total tokens per mutation and current per-token pricing, marginal cost per mutation is on the order of a few cents. A free user's 20 mutations/month costs well under $1. AI cost is not the business risk; distribution is.

---

## 9. Security and threat model

Assets: user records (confidentiality, integrity), the user's trust in commits (integrity of the preview -> commit contract).

Threats and mitigations:

- **Malicious/compromised generated code exfiltrates data**: no network capability in panels (CSP `connect-src 'none'`, no fetch in scope, capability scan). Panels cannot reach other origins, the parent frame, or storage. Exfiltration would require a kernel bridge bug; the bridge accepts only the typed message vocabulary and validates every payload.
- **Prompt injection via user data**: user records are never in model context (8.2). Field *names* are, and are sanitized (length caps, charset). Intent text is the user's own.
- **Cross-panel interference**: panels communicate only via `events` through the kernel; no shared globals; each iframe is a distinct opaque origin.
- **Migration bombs** (e.g., a plan that locks the DB): op vocabulary is finite and each op has a bounded cost; backfills are batched; the dry-run copy catches pathological cases before the real DB is touched.
- **Hosted-mode backend compromise**: blast radius is API-key theft and quota abuse; user data is not on the server. This is a feature of the architecture, and it should be stated publicly as a commitment.
- **The model itself is adversarial-ish**: treat all model output as attacker-controlled input to the validator. The validator's guarantees must not depend on the model being well-behaved.

Out of scope for v1 (documented, not solved): a hostile user attacking their own local instance (they own it), side channels between panels (timing), and supply-chain risk in the kernel's own dependencies beyond standard pinning/auditing.

---

## 10. Technology choices

- **Frontend/shell**: React + TypeScript + Vite. Boring, fast to build, hireable-signal.
- **Store**: `@sqlite.org/sqlite-wasm` with OPFS VFS, in a dedicated Worker.
- **Sandbox**: per-panel iframe, opaque origin, strict CSP; bridge via `postMessage` with a Zod-validated message schema.
- **Panel code loading**: blob URLs of validated ES modules inside the iframe.
- **Validator**: `acorn` for parsing + custom AST walk (small, no Babel weight).
- **Charts (kernel component)**: a small bundled chart lib (e.g., Chart.js) wrapped behind the spec interface; panels never touch it directly.
- **Backend**: Hono on Node (or Cloudflare Workers), endpoints: `POST /auth/magic-link`, `POST /mutations/plan` (proxy), `GET /me`. Postgres only for accounts/quotas. Total backend surface ~500 lines.
- **Hosting**: Vercel (static shell) + a tiny API deployment. Same pipeline as Stoop.
- **Model access**: Anthropic Messages API with structured output.

Deliberately rejected: heavier isolate tech (QuickJS-in-WASM, ShadowRealms) for v1 (iframes are sufficient and shippable); CRDT/sync (v2); React inside panels (vnode vocabulary is smaller, safer, and forces visual consistency).

---

## 11. Build plan (4 weeks, part-time)

**Week 1 - the spine.** SQLite/OPFS worker, schema registry, migration engine with 4 ops + inverses, version log, one hand-written panel rendering through the vnode vocabulary against real data. Exit test: create table, add column, roll back, roll forward, data intact.

**Week 2 - the loop.** Prompt + MutationPlan schema, hosted proxy + BYO-key path, static validator, shadow dry-run, preview/commit UI. Exit test: "add a priority field to tasks and show it as a badge" works end to end from a sentence.

**Week 3 - trust.** Time slider UI, per-panel error boundaries + one-round repair, migration coverage to the full v1 vocabulary, the plain-English diff card, 25-case regression suite of canned intents replayed against the pipeline.

**Week 4 - the demo.** Starter shells (tracker / log / dashboard), onboarding flow, observer with 2 heuristics, landing page with the "your data never leaves, verify in DevTools" section, deploy, record the 90-second demo video (day-1 app -> five sentences -> unrecognizably personal app -> slider rewind).

Cut order if time compresses: observer -> starter shells (ship one) -> repair round (ship error boundary only). Never cut: preview-before-commit, inverses, the validator.

---

## 12. Open risks and honest unknowns

1. **Generation quality variance** is the existential risk. If 1 in 4 mutations needs a repair round, the magic dies. Mitigation is the few-shot library and the constrained vocabulary, but this needs empirical tuning in week 2, and the 25-case suite exists to measure it (target: >= 90% first-pass commit rate).
2. **The vnode vocabulary will be too small.** Users will ask for things the component set can't express. Instrument every validator rejection by reason; the rejection log is the v1.1 roadmap.
3. **Schema evolution complexity compounds.** Twenty migrations deep, interactions get subtle. The linear log and no-destructive-ops rules are chosen to keep the state space foldable; property-based tests on migrate/rollback round-trips are the guardrail.
4. **OPFS/browser storage eviction**: request persistent storage on first commit; export-to-file (single `.clay` archive: db + version log) ships in week 3 as both backup and trust signal.
5. **Positioning risk**: prompt-to-app builders will blur the message. The counter is the demo itself: nothing that ends in "deploy" can show a month-old app absorbing a new feature in one sentence with an undo slider.

---

## 13. What v2 looks like (so v1 doesn't accidentally preclude it)

Sync and multi-device via the version log (it is already an event log; CRDT-ify later). Sharing read-only panels. The `ui.html()` escape hatch with sanitization. A panel gallery seeded from anonymized, user-donated mutations. Local-model mode for the enthusiast tier once small-model codegen against the constrained vocabulary is measurably reliable, which the regression suite can decide.

The v1 decisions that protect these: serializable queries (sync-friendly), whole-blob panels (shareable), the constrained plan format (small-model-friendly), and data-never-on-server (nothing to unwind).
