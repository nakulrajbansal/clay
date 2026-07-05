// Local server entry (Phase 1.1): `pnpm --filter @clay/backend start`.
// Set ANTHROPIC_API_KEY in the environment; point the shell's backend URL
// setting at http://localhost:8787.
import { serve } from "@hono/node-server";
import { createApp } from "./app";

const port = Number(process.env.PORT ?? "8787");
const apiKey = process.env.ANTHROPIC_API_KEY;

const app = createApp({ apiKey });

serve({ fetch: app.fetch, port }, () => {
  console.log(`Clay backend on http://localhost:${port}`);
  console.log(apiKey ? "model key: configured" : "model key: MISSING (set ANTHROPIC_API_KEY)");
});
