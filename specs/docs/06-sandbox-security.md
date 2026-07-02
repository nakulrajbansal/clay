# 06 — Sandbox, Bridge Protocol, and Validator

## 1. Threat model (summary; assets and adversaries)

Assets: A1 user records (confidentiality + integrity), A2 integrity of the
preview->commit contract, A3 the hosted API key/quota, A4 user trust.
Adversaries: model output treated as attacker-controlled (not because the
model is malicious, but because guarantees must not depend on its behavior);
a compromised CDN/dependency; a curious-but-honest backend operator (design
goal: they CAN'T read user data, not merely won't).

## 2. Panel isolation

Each panel: <iframe sandbox="allow-scripts"> with srcdoc bootstrap. No
allow-same-origin -> opaque origin: no cookies, no storage, no parent DOM.
CSP on srcdoc: default-src 'none'; script-src 'unsafe-inline' (the bootstrap
+ blob module only); connect-src 'none'; img-src data:; style-src (kernel
stylesheet hash). Result: no network path exists from panel code — 
exfiltration requires a Bridge bug, not a panel trick.

PanelRuntime (the fixed ~2KB bootstrap inside each iframe):
receives {code, panelId, apiVersion} once via postMessage from the shell,
constructs the `clay` proxy (each method = message send + pending-promise
map), evaluates the module from a Blob URL, invokes default(clay).
It also implements the vnode renderer — panels build vnodes; the runtime
turns them into DOM inside the iframe using only whitelisted tags/components.

## 3. Bridge protocol

Transport: postMessage with structured clone; every message Zod-validated on
the trusted side; unknown/malformed messages dropped + counted (10 strikes ->
panel boundary trips).

```
Panel -> Kernel: {v:1, panel, seq, call: "db.query"|"db.insert"|...,
                  args: [...]}                      // args validated per-call
Kernel -> Panel: {v:1, seq, ok, result | error:{code,message}}
Kernel -> Panel (push): {v:1, kind:"watch", watchId, rows}
                        {v:1, kind:"event", name, payload}
Shell -> Panel (once):  {v:1, kind:"boot", code, panelId, apiVersion, tokens}
```

Kernel-side enforcement per call: panel identity from MessageEvent.source
(never from payload), table access checked against the panel's
declared_queries, rate limits (60 calls/min, watch/emit caps per doc 03),
payload size caps (64KB), and per-call arg schemas. The Bridge is the ONLY
code path where untrusted input meets trusted state; it gets the densest
test coverage in the repo (doc 08).

## 4. Shell-rendered system UI

toast/confirm render in the shell layer so panels cannot draw fake system
dialogs. Panels visually sit inside a shell-drawn frame with the panel title;
nothing a panel renders can appear outside its frame.

## 5. Validator specification (static, pre-execution)

V1 Parse: acorn, module goal, exactly one export default function of arity 1.
V2 Forbidden identifiers (any position, incl. shadowing attempts):
   fetch XMLHttpRequest WebSocket EventSource navigator window document
   globalThis self top parent frames location history localStorage
   sessionStorage indexedDB caches cookie import eval Function
   setTimeout setInterval postMessage Worker SharedArrayBuffer Atomics
   WebAssembly Proxy Reflect constructor __proto__ prototype
V3 Member-access rules: computed access on `clay` forbidden (clay[x]);
   no access to .constructor anywhere; optional chaining fine.
V4 Query consistency: every object literal passed to db.query/db.watch must
   structurally match (subset-equal) one declared_queries entry; conditions'
   VALUES may vary only where the declaration marks a placeholder
   {"value": {"$var": true}} — lets FilterBar-driven queries stay declared.
V5 Migration checks: vocabulary membership, invariants I1–I6 (doc 04),
   referenced tables/columns exist (or are created earlier in the same plan).
V6 Budgets: code <= 64KB/panel, <= 8 panels/plan, <= 3 tables/migration,
   AST depth <= 40, no string > 4KB (curbs data smuggling into code).
V7 Diff honesty: every migration op and panel change must be represented by
   a user_facing_diff line of the right kind (the card can't under-report).
Failures return machine-readable reasons — the same strings fed to the
repair prompt and logged for the v1.1 vocabulary roadmap.

## 6. Supply chain and shell hardening

Pinned lockfile, no post-install scripts, dependency count budget (kernel:
zero runtime deps besides sqlite-wasm, zod, acorn). Site CSP: script-src
'self'; connect-src 'self' + api.anthropic.com (BYO) + clay backend;
frame-src blob:. Subresource integrity on the chart lib. No analytics
scripts on the app surface (landing page only, cookieless).

## 7. Privacy commitments (public, testable)

P1 Records never leave the device (verifiable: DevTools network tab during
   full use; the app functions offline after load).
P2 Hosted mutations transmit schema shapes + intent text only.
P3 BYO key is stored locally and sent only to api.anthropic.com.
P4 Export produces a complete, portable archive; deleting the OPFS directory
   removes all local data.
Each commitment maps to an automated test (doc 08 §5) so the marketing page
is backed by CI, not adjectives.
