# 14 — Reshaping-UI roadmap: from dashboard builder to malleable app

Status: R1–R4 SHIPPED (ADR-022). Horizon items listed at the end are
explicitly out of scope per doc 01 §3 / G17 unless a future ADR reopens them.

## Why this doc exists

Field feedback after the portfolio-dashboard UAT: "the way the panels snap
leaves a lot of empty space… I can't resize some panels… the app feels more
like a dashboard creator than a true reshaping UI." That instinct matches
the current research consensus, so this roadmap grounds Clay's next moves
in it rather than in ad-hoc fixes.

## What the research says (mid-2026 snapshot)

1. **Ink & Switch, “Malleable software” (2025).** The defining essay.
   Malleable systems need a *gentle slope*: direct manipulation →
   lightweight tweaks → composition → (optionally) code, with no cliff
   between steps. Their explicit critique of AI-only reshaping: prompt-
   driven app generators produce isolated artifacts and "require full
   program generation rather than minimal in-moment modifications." A
   dashboard builder is what you get when every change, however small,
   goes through the generator.
2. **CHI 2025, “Generative and Malleable User Interfaces with Generative
   and Evolving Task-Driven Data Model.”** Combines a schema'd data model
   (like Clay's registry) with fine-grained direct manipulation at
   attribute/item/collection level plus prompting for structural change.
   Finding: when changes are small or specific, direct manipulation beats
   prompting; users experienced prompt-only paths as brittle.
3. **CHI 2026 probe, “Conversational Customization of Productivity
   Systems.”** Users reshaped tools successfully via language, but wanted
   modification to be *embedded in use* ("a first-class interaction, not
   an advanced or hidden capability"), continuously refinable, and safely
   experimentable (toggleable/reversible).
4. **“Gradual Generation of User Interfaces” (2026).** Generation should
   expose intermediate, revisitable stages instead of one prompt box —
   users need handles on the artifact between prompts.

Clay already holds the hard invariants these papers ask for (data outlives
interface; preview-before-commit; one reversible timeline; sandboxed
panels). What it lacked was the BOTTOM of the gentle slope: friction-free
physical manipulation, and local paths for small changes.

## Gap analysis: why Clay felt like a dashboard creator

| Symptom | Root cause | Roadmap item |
|---|---|---|
| Uneven sizes leave holes | main grid row-flows without dense packing; no masonry | R1 |
| Some panels can't be resized | top region had no handles at all; width was main-only | R2 |
| Renaming/removing a panel needs a prompt + preview + keep | no local ops below the pipeline | R3 |
| Language edits feel aimed at "the app", not the thing you're looking at | composer has no pointing gesture | R4 |

## The roadmap

- **R1 — Layout that packs itself (SHIPPED).** Top and main are one 4-col
  grid; masonry placement (1px rows + measured-height spans + dense flow)
  means uneven panels tile tightly. No schema change (ADR-018/019 fields
  reused; top default span 4).
- **R2 — Resize anything (SHIPPED).** Width (1–4 cols) + height drag on
  every top/main panel; height on side panels. All resizes are reversible
  layout commits on the shared timeline. Side rail width stays fixed by
  design — moving a side panel to main IS its "make it bigger."
- **R3 — Small changes never call the model (SHIPPED).** Double-click a
  panel title to rename; ✕ removes a panel (confirm; rewindable). Kernel
  ops reuse the existing commit vocabulary — no capability widening
  (ADR-022c). This is MacLean's first rung and Jelly's core finding made
  concrete: manipulation for small, prompting for structural.
- **R4 — Point, then speak (SHIPPED).** Every panel gets a ✨ affordance
  that seeds the composer with `In the “<title>” panel: `. Pointing plus
  language in one gesture; the pipeline is untouched.

## Horizon (not on this roadmap; pre-decided noes unless re-ADR'd)

- **Element-level provenance** ("why is this cell red?") — a strong
  malleability pattern (Ink & Switch), but requires panel-runtime
  introspection surface; revisit after launch gates L1–L5.
- **Panel decomposition/recombination** (drag a column out of a table to
  make a new panel) — Jelly-style; needs plan-synthesis without the model
  or a local planner; deferred.
- **Communal malleability** (sharing reshaped apps) — multi-user is a
  pre-decided no (doc 01 §3).
- **In-panel formula authoring** — the compute.eval surface exists, but a
  user-facing formula bar widens the trusted surface; needs its own ADR.

## Sources

- https://www.inkandswitch.com/essay/malleable-software/
- https://dl.acm.org/doi/10.1145/3706598.3713285 (CHI 2025)
- https://arxiv.org/html/2605.11149 (CHI 2026 probe)
- https://arxiv.org/html/2601.17975v1 (Gradual Generation, 2026)
- https://arxiv.org/html/2508.19227 (Generative Interfaces for LMs)
