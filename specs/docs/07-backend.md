# 07 — Backend Specification (hosted mode)

Deliberately thin. If this document grows, the architecture is drifting.

## 1. Endpoints (Hono, TypeScript, shared schema package)

POST /auth/magic-link {email} -> 204 (sends link; rate: 3/hour/email)
GET  /auth/callback?token=    -> session cookie (httpOnly, 30d, rolling)
POST /auth/logout             -> revokes session + expires cookie
GET  /me                      -> {user_id, plan, mutations_used, quota, period_end}
POST /mutations/plan          -> proxies to the selected hosted model provider
     body: {context: S1Context}
     resp: raw structured-output text. The worker hydrates and validates it
           before shadow execution; malformed output is never executed.
     guards: auth required; quota check+increment (atomic, Postgres);
             application/json; body <= 64KB
POST /mutations/repair        -> same shape + error payload; counts against
                                 the SAME attempt (no double quota charge)
GET  /healthz

Production is fail-closed. Vercel and the Node/Fly entry require
`DATABASE_URL`, `RESEND_API_KEY`, a valid `FROM_EMAIL`, a bare HTTPS
`APP_ORIGIN`, and the credential for the selected `MODEL_PROVIDER`
(`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`). Missing or malformed configuration
returns 503 on Vercel or prevents the Node server from starting.
Dev links require the explicit local-only `AUTH=dev` switch.

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
Quota admission is one conditional Postgres update, so concurrent serverless
requests cannot race above the free limit. Request bodies are stream-counted
against the 64KB cap even when Content-Length is absent.

## 4. Model proxy behavior

Adds the server-held provider key and uses the shared prompt and simplified
MutationPlan output schema. Anthropic uses `output_config`; OpenAI Responses
uses strict JSON schema with `store:false` and no tools. Streams are disabled.
Prompt changes ship like code through regression and product gates.

## 5. Ops

Deploy: Fly.io or Vercel (+ Postgres). Logs: structured,
no payload bodies. Alerts: first-pass commit rate (from client-reported
attempt beacons, opt-in), 5xx rate, upstream latency p95. Backups: Postgres
daily (accounts only — user app data doesn't exist here, the backup story
for app data is the client-side .clay export).

## 6. BYO-key mode

Client calls api.anthropic.com directly (CORS-permitting endpoint w/
anthropic-dangerous-direct-browser-access acknowledged in settings UX),
key in device-local browser storage, never sent to Clay. Backend untouched. Feature
parity except quota UI. This mode must remain first-class: it is the trust
anchor and the HN launch story.
