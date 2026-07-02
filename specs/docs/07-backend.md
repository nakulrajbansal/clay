# 07 — Backend Specification (hosted mode)

Deliberately thin. If this document grows, the architecture is drifting.

## 1. Endpoints (Hono, TypeScript, shared schema package)

POST /auth/magic-link {email} -> 204 (sends link; rate: 3/hour/email)
GET  /auth/callback?token=    -> session cookie (httpOnly, 30d, rolling)
GET  /me                      -> {user_id, plan, mutations_used, quota, period_end}
POST /mutations/plan          -> proxies to Anthropic
     body: {context: S1Context, intent: string}   // Zod-validated
     resp: MutationPlan (validated server-side against the same Zod schema
           before returning — the server never relays malformed plans)
     guards: auth required; quota check+increment (atomic, Postgres);
             body <= 64KB; 2 concurrent per user; 30s upstream timeout
POST /mutations/repair        -> same shape + error payload; counts against
                                 the SAME attempt (no double quota charge)
GET  /healthz

## 2. Data (Postgres)

users(id, email, created_at, plan)          plans: free | pro
usage(user_id, period_start, mutations_used)
attempt_log(id, user_id, at, outcome, tokens_in, tokens_out, latency_ms)
   -- NO intent text, NO schema payloads stored. Operational metrics only.
   -- This is a design commitment (doc 06 §1: curious operator can't read
   -- what they don't retain), not merely a privacy-policy line.

## 3. Quotas and plans

free: 20 mutations / rolling 30 days. pro ($8/mo, Stripe, v1.1 — launch may
be free+BYO only): unlimited mutations, priority model tier, future sync.
Repair rounds free (they're Clay's failure, not the user's). Meter surfaced
via /me and shown in the conversation rail at >= 50% consumption.

## 4. Model proxy behavior

Adds server key, sets structured-output schema, streams disabled v1
(plans are all-or-nothing), retries 429/5xx twice with jitter, tags requests
with hashed user id for Anthropic-side abuse visibility. Prompt version
pinned per deploy; prompt changes ship like code (PR + regression gate).

## 5. Ops

Deploy: Fly.io or Cloudflare Workers (+ Neon Postgres). Logs: structured,
no payload bodies. Alerts: first-pass commit rate (from client-reported
attempt beacons, opt-in), 5xx rate, upstream latency p95. Backups: Postgres
daily (accounts only — user app data doesn't exist here, the backup story
for app data is the client-side .clay export).

## 6. BYO-key mode

Client calls api.anthropic.com directly (CORS-permitting endpoint w/
anthropic-dangerous-direct-browser-access acknowledged in settings UX),
key in system.db settings, never sent to Clay. Backend untouched. Feature
parity except quota UI. This mode must remain first-class: it is the trust
anchor and the HN launch story.
