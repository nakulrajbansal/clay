// Vercel serverless entry (same-origin deploy): static shell from the CDN,
// this function behind /auth/*, /me, /mutations/*, /healthz (vercel.json
// rewrites). State lives in Postgres (PgSessions/PostgresAuthStore) because
// every invocation may be a fresh instance — see packages/backend.
import { Hono } from "hono";
import { handle } from "hono/vercel";
import { createApp, type BackendOptions } from "../packages/backend/src/app";
import { PgSessions, PostgresAuthStore } from "../packages/backend/src/pg-store";

const dbUrl = process.env.DATABASE_URL;
const resendKey = process.env.RESEND_API_KEY;
const fromEmail = process.env.FROM_EMAIL ?? "Clay <login@example.com>";
const appOrigin = (process.env.APP_ORIGIN ?? "").replace(/\/$/, "");

let ready: Promise<Hono> | null = null;

async function build(): Promise<Hono> {
  let auth: BackendOptions["auth"];
  if (dbUrl) {
    const store = PostgresAuthStore.connect(dbUrl);
    await store.ensureSchema();
    auth = {
      store,
      sessions: new PgSessions(store.db),
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
  }
  const app = createApp({ apiKey: process.env.ANTHROPIC_API_KEY, auth });
  // tolerate both original-path and /api-prefixed invocation
  const outer = new Hono();
  outer.route("/", app);
  outer.route("/api", app);
  return outer;
}

export default async function handler(req: Request): Promise<Response> {
  ready ??= build();
  return handle(await ready)(req);
}
