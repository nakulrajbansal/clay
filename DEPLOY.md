# Deploying Clay (Phase 1.3)

Two supported targets. Both serve the API and the built shell from ONE
origin (same origin → session cookies work with no CORS gymnastics).

- **Vercel + Supabase** (primary): static shell on the CDN, the backend as
  a serverless function (`api/index.ts` + `vercel.json` rewrites). All
  auth state — sessions, magic-link tokens, rate limits — lives in
  Postgres (`PgSessions`), because serverless instances share no memory.
- **Fly.io** (alternative): one long-running container (`Dockerfile` +
  `fly.toml`), backend serves `STATIC_DIR`. Production still requires
  Postgres and real email delivery.

## Accounts you need (once)
1. **Model provider** — Anthropic or OpenAI. Set `MODEL_PROVIDER` and the
   matching server API key. Local Codex subscription mode is intentionally a
   loopback development connector, not a hosted deployment credential.
2. **Hosting** — Vercel (primary) or Fly.io.
3. **Postgres** — Supabase or Neon: `DATABASE_URL`. Required on Vercel.
   Schema auto-creates on first request (users, usage, login_tokens,
   sessions — counters and session ids only, never app data).
   Supabase: use the **transaction pooler** string (port 6543) — direct
   connections (5432) exhaust fast under serverless. Free-tier Supabase
   pauses after ~1 week of inactivity; open the dashboard to wake it.
4. **Email** — Resend: `RESEND_API_KEY` + a verified `FROM_EMAIL` domain.
   Missing production dependencies fail closed with HTTP 503. Magic links
   are returned in an API response only when a local server explicitly sets
   `AUTH=dev`.
5. **Domain** — set `APP_ORIGIN=https://yourdomain.com` so emailed links
   resolve (on Vercel this is your `*.vercel.app` URL until you attach a
   domain).

## Vercel + Supabase steps
1. Supabase → New project → copy the **Transaction pooler** connection
   string from Connect (postgres://...pooler.supabase.com:6543/postgres).
2. Vercel → Add New Project → import the GitHub repo. Framework preset:
   **Other**. Build command and output dir come from `vercel.json`
   (`pnpm --filter @clay/shell build` → `packages/shell/dist`).
3. Project → Settings → Environment Variables:
   `MODEL_PROVIDER`, the matching `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`,
   `DATABASE_URL` (pooler string), `RESEND_API_KEY`, `FROM_EMAIL`, and
   `APP_ORIGIN` (the deployment URL).
   All listed variables are required. A partially configured deployment does
   not expose an unauthenticated mutation proxy or dev magic links.
4. Deploy. Nothing to configure in the app: on an https deploy the shell
   defaults its backend to the page's own origin (Settings can still
   override for cross-origin setups), and clicking a magic-link email
   lands directly in the app, signed in.

## Fly.io steps (alternative)
```sh
fly launch --no-deploy            # accept the existing fly.toml
fly secrets set MODEL_PROVIDER=openai OPENAI_API_KEY=... DATABASE_URL=... \
  RESEND_API_KEY=... FROM_EMAIL="Clay <login@yourdomain.com>" \
  APP_ORIGIN=https://yourdomain.com
fly deploy
```

## Post-deploy launch gates
- `GET /healthz` → `{"ok":true,"model":true,"provider":"openai","model_id":"gpt-5.6"}`
- Sign-in round-trip with a real inbox (link lands, one click signs in)
- Re-run the template audit against the deployed URL:
  `URL=https://yourdomain.com node scripts/templatereview.mjs`
- Cross-browser spot check: `URL=... node scripts/browsers.mjs`
- Real-Safari (macOS) persistence check — the one gate that needs a Mac.

## Notes
- With `DATABASE_URL` set, sessions/tokens/rate-limits are durable
  (Postgres, `PgSessions`) — redeploys keep users signed in. The
  in-memory store remains for explicit local development only (`AUTH=dev`).
- Session cookies are `Secure` on HTTPS, logout revokes the server session,
  body limits are enforced while streaming, and free-plan quota admission is
  atomic under concurrent requests.
- The privacy commitment holds server-side: users + usage counters +
  opaque session ids only, no intent text, no schema payloads (doc 07 §2).

## Local Codex subscription connector

Local Codex is a loopback-only Preview path, not a hosted deployment mode.
Run `codex login`, then `pnpm codex` (or double-click `clay-codex.cmd`). The
connector binds `127.0.0.1:8788`, runs Codex ephemeral/read-only in an empty
working directory, applies Clay's output schema, and returns only the raw plan
to the normal local validator and preview pipeline. Set `CODEX_MODEL` only when
you need to override the model selected by the Codex CLI. The connector uses
`codex exec --ephemeral --ignore-user-config` on every OS. App-server mode is
deliberately rejected because it cannot ignore user MCP and tool configuration.
