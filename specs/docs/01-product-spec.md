# 01 — Product Specification

## 1. Positioning

One line: everyone else sells the factory (prompt-to-app builders); Clay sells
the clay. The product is not "generate an app." It is "own an app that keeps
reshaping itself around you, with your data safe underneath."

Category boundaries (what Clay is NOT, stated to prevent scope drift):
not a site builder, not a no-code platform, not a chatbot, not a BI tool,
not a database admin UI. It is a personal application with one superpower.

## 2. Personas and jobs-to-be-done

P1 — The operator (primary for revenue, later). Runs a small service business.
Job: "run my business my way without paying for bloated vertical SaaS or a
freelancer." Tolerance for jank: low. Needs: reliability, undo, simple words.

P2 — The inside-ops person (primary for v1 adoption). PM / ops / chief-of-staff
type inside a company. Job: "get the tracker my team actually needs without a
Jira admin and a quarter of waiting." Comfortable with structured thinking,
not with code. This persona evaluates fastest and evangelizes loudest.

P3 — The personal-tools tinkerer (primary for launch buzz). Tracks reading,
training, money, collections. Job: "one app that does MY 100% instead of five
apps that each do 70%." Will use BYO-key mode. Finds Clay via HN/Twitter.

Anti-persona: teams needing multi-user collaboration (v2), developers who want
code export (explicitly never promised in v1).

## 3. Core user stories (v1 scope, testable)

US-01 As a new user, I pick a starter shell (tracker / log / dashboard) and
      have a working, data-entry-capable app in under 60 seconds, no model call.
US-02 As a user, I describe a change in one sentence and see a live preview
      plus a plain-English diff before anything becomes permanent.
US-03 As a user, I can add fields, computed fields, panels, charts, filters,
      forms, and statuses through sentences alone.
US-04 As a user, I can drag a time slider to any prior version and my app
      (UI + schema) is exactly as it was, with all my records intact.
US-05 As a user, when a change fails, I see what was attempted and my app is
      untouched.
US-06 As a user, my records never leave my device; I can verify via DevTools
      and by using the app offline.
US-07 As a user, I can export my entire app (data + history) to a single file
      and re-import it on another machine.
US-08 As a user, I occasionally receive one suggestion based on how I actually
      use the app, and dismissing it makes it stay gone.
US-09 As a BYO-key user, I paste my Anthropic key and mutate without limits;
      the key never leaves my browser except to Anthropic.
US-10 As a hosted free user, I get 20 mutations/month and a clear meter.

Out of scope v1 (recorded so "no" is pre-decided): multi-user, mobile layout
polish beyond readable, panel marketplace, external integrations/webhooks,
imports from CSV (v1.1 candidate), custom raw HTML panels, branching history.

## 4. UX flows

### 4.1 First run
Landing -> "Start shaping" -> shell picker (3 cards, each with a 5-second
looping preview) -> app opens with seed columns + 3 sample rows (clearly
marked, one-click removable) -> conversation panel open with placeholder:
"Describe what you want to track" -> first mutation is the aha moment.
Target: first kept mutation within 3 minutes of landing.

### 4.2 The mutation loop (the product's grammar)
describe -> (optional single clarifying question) -> preview + diff card ->
Keep / Discard. Preview renders the REAL panel against a shadow copy of the
user's data, in place, with a dashed accent border marking "proposed."
Diff card lines are typed: add_field / change_panel / add_panel / add_status /
add_computed, plus the constant final line "Your data: untouched."

### 4.3 Rollback
History button or slider drag -> app re-renders at version K in <500ms ->
banner: "Viewing v{K} of {N} — [Return to latest] [Make this the latest]".
Choosing "make latest" warns once that later versions will be discarded.

### 4.4 Failure
Stage-4 failure after repair round: conversation shows an amber card,
"That change didn't work. Here's what I tried: {summary}. Nothing was changed."
Runtime panel failure: panel replaced by compact card with Repair / Roll back
this panel / Dismiss.

### 4.5 Suggestion
At most one blue suggestion card at a time, only in the conversation panel,
never a popup. Accept enters the normal loop; dismiss records a tombstone
(suggestion type + subject) suppressing that suggestion permanently.

## 5. Screen inventory

S1 Landing page (static): demo video, "verify in DevTools" section, shell picker CTA.
S2 Main app: header (name, version chip, history, data, settings) / panel
   canvas (regions: top strip, main grid, side) / conversation rail
   (collapsible; collapsed by default after 7 days of use) / footer slider.
S3 Data view: raw table browser per registered table — the escape hatch that
   proves records are just records. Read + inline edit + soft delete.
S4 History view: vertical list of commits (intent text, summary, timestamp),
   click to preview that version.
S5 Settings: mode (hosted/BYO key), export/import .clay archive, storage
   persistence status, account/quota (hosted).
S6 Onboarding shell picker.

## 6. Voice and copy rules

Sentence case. No exclamation marks in system copy. The app never says "AI."
Verbs of craft, not chat: "shape," "keep," "discard," "rewind." The diff card
always ends with the data-safety line. Errors say what happened and what to do,
never apologize twice. The conversation input placeholder is always a concrete
example, rotated: "Add a status field with To do / Doing / Done", "Show a
chart of entries per week", "Flag anything overdue in red".

## 7. Success metrics (v1)

Activation: % of new users reaching first kept mutation (target 40%+).
Magic rate: first-pass commit rate on mutations (target >= 90%).
Trust: rollback usage without churn (rollbacks are healthy; uninstall-after-
failed-mutation is the death signal).
Retention proxy: users making a mutation in week 3 after signup.
