// Local server entry (Phase 1.1): `pnpm --filter @clay/backend start`.
// Set ANTHROPIC_API_KEY in the environment; point the shell's backend URL
// setting at http://localhost:8787.
import { serve } from "@hono/node-server";
import { createApp, makeDevAuth } from "./app";

const port = Number(process.env.PORT ?? "8787");
const apiKey = process.env.ANTHROPIC_API_KEY;
// Phase 1.2: AUTH=dev turns on magic-link auth + quotas with in-memory
// storage and links printed to the response (no email provider needed).
// Production needs a Postgres AuthStore adapter + real email sender —
// both deploy-time concerns (doc 07 §5).
const auth = process.env.AUTH === "dev" ? makeDevAuth() : undefined;

const app = createApp({ apiKey, auth });

serve({ fetch: app.fetch, port }, () => {
  console.log(`Clay backend on http://localhost:${port}`);
  console.log(apiKey ? "model key: configured" : "model key: MISSING (set ANTHROPIC_API_KEY)");
  console.log(auth ? `auth: dev magic-links + quotas ON` : "auth: open (Phase 1.1 local mode)");
});
