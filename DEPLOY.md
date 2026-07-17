# Deploying Clay (Phase 1.3)

One container serves both the API and the built shell (same origin →
session cookies work with no CORS gymnastics).

## Accounts you need (once)
1. **Anthropic** — server API key (`ANTHROPIC_API_KEY`).
2. **Hosting** — Fly.io (this repo ships `Dockerfile` + `fly.toml`).
   Cloudflare Workers is possible later but needs a Workers-compatible
   entry (the Node server here targets Fly/containers).
3. **Postgres** — Neon (free tier is fine): `DATABASE_URL`.
   Setting it enables real accounts; the schema auto-creates on boot.
4. **Email** — Resend: `RESEND_API_KEY` + a verified `FROM_EMAIL` domain.
   Without it, magic links are returned in the API response (dev mode) —
   fine for staging, not for production.
5. **Domain** — point DNS at Fly; set `APP_ORIGIN=https://yourdomain.com`
   so emailed links resolve.

## Steps
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
- Sessions are in-memory by design v1: a redeploy signs users out but
  loses nothing (app data lives in the user's browser; accounts re-link
  by email). Durable sessions move to Postgres with sharing (task #67).
- The privacy commitment holds server-side: users + usage counters only,
  no intent text, no schema payloads (doc 07 §2).
