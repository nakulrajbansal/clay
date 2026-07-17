// Server entry. Local dev: `pnpm --filter @clay/backend start`.
//   ANTHROPIC_API_KEY  server model key (required for reshapes)
//   AUTH=dev           magic links returned in the response (no email)
//   DATABASE_URL       Postgres -> real accounts (enables auth)
//   RESEND_API_KEY     transactional email for magic links (with FROM_EMAIL)
//   APP_ORIGIN         absolute origin used in emailed links
//   STATIC_DIR         serve the built shell (same-origin = cookies work)
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp, makeDevAuth, type BackendOptions } from "./app";
import { MemoryAuthStore, Sessions } from "./auth";
import { PostgresAuthStore } from "./pg-store";

const port = Number(process.env.PORT ?? "8787");
const apiKey = process.env.ANTHROPIC_API_KEY;
const dbUrl = process.env.DATABASE_URL;
const resendKey = process.env.RESEND_API_KEY;
const fromEmail = process.env.FROM_EMAIL ?? "Clay <login@example.com>";
const appOrigin = (process.env.APP_ORIGIN ?? `http://localhost:${port}`).replace(/\/$/, "");

async function main(): Promise<void> {
  let auth: BackendOptions["auth"];
  if (dbUrl) {
    const store = PostgresAuthStore.connect(dbUrl);
    await store.ensureSchema();
    auth = {
      store, sessions: new Sessions(),
      devLinks: !resendKey,
      sendEmail: resendKey
        ? async (email, link) => {
            const res = await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: { "content-type": "application/json",
                authorization: `Bearer ${resendKey}` },
              body: JSON.stringify({
                from: fromEmail, to: [email],
                subject: "Your Clay sign-in link",
                text: `Sign in to Clay: ${appOrigin}${link}\n\n`
                  + "The link works once and expires in 15 minutes.",
              }),
            });
            if (!res.ok) throw new Error(`resend ${res.status}`);
          }
        : undefined,
    };
  } else if (process.env.AUTH === "dev") {
    auth = makeDevAuth();
  }
  void MemoryAuthStore;

  const app = createApp({ apiKey, auth });
  const staticDir = process.env.STATIC_DIR;
  if (staticDir) {
    app.use("/*", serveStatic({ root: staticDir }));
    app.get("*", serveStatic({ path: `${staticDir}/index.html` }));
  }

  serve({ fetch: app.fetch, port }, () => {
    console.log(`Clay backend on http://localhost:${port}`);
    console.log(apiKey ? "model key: configured" : "model key: MISSING");
    console.log(auth
      ? `auth: ON (${dbUrl ? "postgres" : "dev/in-memory"}, links via ${resendKey ? "resend email" : "dev response"})`
      : "auth: open (local mode)");
    if (staticDir) console.log(`serving shell from ${staticDir}`);
  });
}

void main();
