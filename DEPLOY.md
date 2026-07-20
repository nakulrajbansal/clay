# Deploying Clay (Phase 1.3)

Two supported targets. Both serve the API and the built shell from ONE
origin (same origin → session cookies work with no CORS gymnastics).

- **Vercel + Supabase** (primary): static shell on the CDN, the backend as
  a serverless function (`api/index.ts` + `vercel.json` rewrites). All
  auth state — sessions, magic-link tokens, rate limits — lives in
  Postgres (`PgSessions`), because serverless instances share no memory.
- **Fly.io** (alternative): one long-running container (`Dockerfile` +
  `fly.toml`), backend serves `STATIC_DIR`. Works with either Postgres
  or the in-memory session store.

## Accounts you need (once)
1. **Anthropic** — server API key (`ANTHROPIC_API_KEY`).
2. **Hosting** — Vercel (primary) or Fly.io.
3. **Postgres** — Supabase or Neon: `DATABASE_URL`. Required on Vercel.
   Schema auto-creates on first request (users, usage, login_tokens,
   sessions — counters and session ids only, never app data).
   Supabase: use the **transaction pooler** string (port 6543) — direct
   connections (5432) exhaust fast under serverless. Free-tier Supabase
   pauses after ~1 week of inactivity; open the dashboard to wake it.
4. **Email** — Resend: `RESEND_API_KEY` + a verified `FROM_EMAIL` domain.
   Without it, magic links are returned in the API response (dev mode) —
   fine for staging, not for production.
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
   `ANTHROPIC_API_KEY`, `DATABASE_URL` (pooler string), `RESEND_API_KEY`,
   `FROM_EMAIL`, `APP_ORIGIN` (the deployment URL).
   Omit `RESEND_API_KEY` on a staging deploy to get dev links.
4. Deploy. Nothing to configure in the app: on an https deploy the shell
   defaults its backend to the page's own origin (Settings can still
   override for cross-origin setups), and clicking a magic-link email
   lands directly in the app, signed in.

## Fly.io steps (alternative)
```sh
fly launch --no-deploy            # accept the existing fly.toml
fly secrets set ANTHROPIC_API_KEY=... DATABASE_URL=... \
  RESEND_API_KEY=... FROM_EMAIL="Clay <login@yourdomain.com>" \
  APP_ORIGIN=https://yourdomain.com
fly deploy
```

## Post-deploy launch gates
- `GET /healthz` → `{"ok":true,"model":true}`
- Sign-in round-trip with a real inbox (link lands, one click signs in)
- Re-run the template audit against the deployed URL:
  `URL=https://yourdomain.com node scripts/templatereview.mjs`
- Cross-browser spot check: `URL=... node scripts/browsers.mjs`
- Real-Safari (macOS) persistence check — the one gate that needs a Mac.

## Notes
- With `DATABASE_URL` set, sessions/tokens/rate-limits are durable
  (Postgres, `PgSessions`) — redeploys keep users signed in. The
  in-memory store remains for local dev (`AUTH=dev`) and container
  deploys without a database.
- The privacy commitment holds server-side: users + usage counters +
  opaque session ids only, no intent text, no schema payloads (doc 07 §2).
