# 13 — The Moat, and the plan to widen it

This doc names what makes Clay defensibly different, then lays out a
step-by-step plan that leans into that difference. It supplements the
roadmap (doc 12); where they differ this one wins for prioritization.

## What Clay is NOT (and why that matters)

- **Not a UI generator** (v0, Claude Artifacts, Lovable). Those emit
  throwaway code with no persistent data and no way to evolve in place.
- **Not a configured database** (Airtable, Notion, Coda). Those are
  menu-driven: powerful but frozen to a fixed capability surface; you
  adapt to the tool.
- **Not an internal-tools builder** (Retool, Budibase). Those target
  developers dragging widgets onto a canvas.

## The moat: a liquid interface over a permanent substrate

Clay's defensible combination — none of the above has all four:

1. **Generative UI that reshapes IN PLACE by natural language.** You
   describe a change; the running app becomes it. No menus, no rebuild.
2. **Over a sacred data substrate.** Data outlives every interface (P1).
   Reshaping never risks the data; the UI is a *projection*, not the
   source of truth.
3. **Every transformation is reversible, previewed, and sandboxed.** The
   change history is a navigable timeline (scrub/rewind); nothing commits
   without preview; generated code can't touch data or escape its frame.
4. **One dataset, arbitrarily many live views.** Change data in any view,
   every view updates. The same rows are a board, a table, a timeline, a
   chart — simultaneously.

**The methodology no one else ships: the UI as a reversible, generated
projection over data, with change-history as a first-class dimension.**
Competitors either freeze the UI (config tools) or discard it
(generators). Clay keeps the UI liquid AND the data permanent AND the
whole evolution navigable. That triangle is the moat.

## Where the moat is currently thin (and the bets to thicken it)

- **B1 — Coherent identity across apps.** Model access, preferences, and
  style should be *yours*, following you across every app — not re-entered
  per app. (Also: keys must never live in a per-app export.)
- **B2 — Templates that are useful on arrival.** A liquid app still needs
  a strong starting shape. Each starter should match what the best app in
  its domain does, so it's usable from minute one and a rich substrate to
  reshape.
- **B3 — Ambient reshaping.** The Observer notices patterns; escalate it
  to proactive, one-click transformations ("you always filter to X —
  pin it as a view?"). The app meets you halfway.
- **B4 — Direct-manipulation ⇄ language.** Let the user grab, reorder, and
  resize panels directly; record those as the same reversible mutations.
  Two modes, one history — a transforming UI you can also touch.
- **B5 — Fork-and-explore.** Beyond single-step preview: branch a view or
  a whole app, experiment freely, keep or discard. Time as a canvas.
- **B6 — Cross-app data references.** The substrate spans apps: a CRM deal
  links to a bookkeeping invoice. One personal data graph, many lenses.
- **B7 — House style / design memory.** Generated UI should look
  consistent and good by default — a learned, applied design system so
  every reshape is on-brand, not ad hoc.

## The step-by-step plan (this initiative)

Ordered; each ships tested and committed on its own.

1. **Global model access (B1).** Key + backend URL live once, on the
   device (localStorage), pushed to the worker — shared by every app,
   never written to a per-app DB or export. Migrate existing per-app keys
   up. → the "don't ask me again" fix. **[doing first]**
2. **Best-in-class templates (B2).** Rewrite the business templates to
   match category leaders (CRM≈Pipedrive/HubSpot, Bookkeeping≈Wave/
   QuickBooks, Projects≈Asana/Linear, plus a couple new domains), each
   multi-table with the entities and views a real user expects, ready to
   use and rich to reshape.
3. **House style (B7).** A single applied token system so generated
   panels are consistent and polished by default (feeds every reshape).
4. **Ambient reshaping (B3).** Stronger Observer → proactive, one-click
   transformation offers surfaced in-context.
5. **Direct manipulation (B4).** Drag-reorder / resize panels, recorded as
   reversible mutations — the transforming UI made tactile.
6. **Fork-and-explore (B5)** and **cross-app references (B6).** The
   larger, later bets that make the substrate a graph and time a canvas.

Steps 1–2 are the user's immediate asks and the fastest usefulness wins;
3–5 are the differentiators that competitors structurally can't copy
without also being liquid-over-permanent.

## Initiative II — Make the moat *legible* (the pillars, on screen)

The four moat pillars exist in the kernel but are unevenly surfaced. A moat
you can't see isn't a moat a user feels. This initiative makes each pillar
tangible in the trusted shell — no new capability surface (Bridge/Validator/
migration vocabulary unchanged), so no ADR is required; these are read-only
projections and reversible layout/state, all honoring P1–P5.

Ordered by (moat value × achievability × verifiability):

1. **Change-history as a first-class surface (pillar 3).** A navigable
   *evolution timeline*: every version with the words you asked, what changed,
   and when — jump to any moment (read-only render) or rewind to it. The thin
   scrubber becomes a real, legible history. **[SHIPPED — HistoryView]**
2. **Named checkpoints.** Label a moment ("before invoicing") and pin it on
   the timeline, so history has meaning, not just numbers. A per-version
   label store in sys (out of the data substrate). **[SHIPPED]**
3. **Ambient reshaping v2 (B3).** Escalate the Observer from passive chips to
   proactive, one-click offers ("3 tasks are overdue — surface them?";
   "you only see a list — view them as a board?"), re-derived on a gentle
   idle cadence so patterns from data entry are noticed on their own. Local
   heuristics only (P4). **[SHIPPED]**
4. **Fork-and-explore (B5).** Duplicate an app (schema + data + history +
   panels) into a new one via the validated `.clay` export/import path into a
   fresh OPFS namespace, then switch to it — try a big redesign without
   risking the real app. Time/branching as a canvas. **[SHIPPED]**
5. **One dataset ⇄ many views, made switchable (pillar 4).** A view-switcher
   affordance so the same rows flip between board / table / chart in place —
   the "same data, many lenses" claim you can touch. **[next]**

Each ships tested (logic + a screenshot-verified render) and committed alone.
