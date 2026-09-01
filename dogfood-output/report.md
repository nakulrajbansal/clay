# Clay product dogfood report

Date: 2026-08-31
Target: `http://127.0.0.1:4173`
Scope: ordinary product behavior, data durability, reversible changes, interface quality, accessibility, responsive behavior, persistence, performance budgets, and cross-browser behavior. Detailed boundary-regression work was excluded per `CLAY_CLEAN_CONTINUATION.md`.

## Executive summary

The current production build is ready for Nakul's ordinary product testing. The tested slice adds Shape Map, Change Contracts, post-keep trust receipts, panel provenance, situational lenses, a collapsible reshape rail, the Kiln visual system, and data-preserving rollback behavior.

Open ordinary product blockers: **0**.
Resolved ordinary defects during dogfooding: **10**.
Deferred boundary-regression failures: **2 focused tests**, requiring OpenAI Trusted Access before further work.

## Verified user journeys

- Start a Sales CRM app and render every starter panel.
- Preview, discard, and keep a deterministic reshape.
- Inspect a post-keep trust receipt and exact rewind target.
- Confirm an older Rewind action names all currently newer versions before truncation.
- Inspect why a live panel exists, including creation and latest-shape history.
- Switch among All views, Morning review, Focus, and Update data lenses.
- Restore All views in one action and persist a lens across reload.
- Keep full-layout arrangement controls inactive while a filtered lens is active.
- Open Shape Map, inspect permanent data, live views, and evolution.
- Open underlying data and target a specific panel for reshaping.
- Collapse and restore the reshape rail.
- Export app A, import its archive into app B, and confirm app A remains intact.
- Perform offline form writes and reload persistent records in Chromium and Firefox.
- Boot the documented session-only fallback in WebKit.
- Reach every Settings control at a 390 × 844 viewport.

## Resolved defects

1. Trust receipt clicks were overlapped by rail suggestions.
2. A selected lens was overwritten during boot before panels loaded.
3. Panel and Shape Map opacity animations temporarily lowered text contrast.
4. Success-toast action contrast failed WCAG AA.
5. Old Keep-toast callbacks could truncate unrelated later versions without current confirmation.
6. Receipts for truncated versions remained in the session feed.
7. A preview could be kept after a newer shape version changed its base.
8. Drag and resize actions used unsafe full-layout indexes while a filtered lens was active.
9. Re-created panel IDs reported provenance from an older removed incarnation.
10. Importing one app archive wiped sibling app storage and reopened the wrong namespace.

## Automated evidence

- Strict TypeScript: all six packages pass.
- Ordinary tests: **611 passed**.
- Production build: pass.
- Main bundle: 841,606 B raw / 245,314 B gzip.
- Database worker: 640,307 B raw / 184,632 B gzip.
- Application CSS: 49,196 B raw / 9,678 B gzip.
- Production dependency audit: no known vulnerabilities.
- Serious/critical axe violations: zero across trusted release surfaces and all 11 themes.
- Chromium, Firefox, and WebKit ordinary browser gates: green.
- Page errors across product journeys: zero.

## Visual proof

- `evidence/nextgen-shape-map-desktop.png`
- `evidence/nextgen-shape-map-compact.png`
- `evidence/nextgen-shape-map-phone.png`
- `evidence/nextgen-change-contract.png`
- `evidence/nextgen-trust-provenance.png`

## Deferred work and GitHub status

The complete repository test command still includes two focused boundary-regression tests intentionally deferred by the clean-continuation brief until OpenAI Trusted Access is enabled. Therefore the full `pnpm test` / `pnpm check` contract is not green, and this working tree has not been committed or pushed. Ordinary product testing can proceed against the live production preview without changing that constraint.
