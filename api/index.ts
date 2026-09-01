// Vercel serverless entry (same-origin deploy). Production configuration is
// deliberately fail-closed: no database, email delivery, app origin, or model
// key means no mutation proxy and no dev magic links.
import { Hono } from "hono";
import { handle } from "hono/vercel";
import { createApp } from "../packages/backend/src/app";
import { PgSessions, PostgresAuthStore } from "../packages/backend/src/pg-store";

export type ServerlessEnv = {
  DATABASE_URL?: string;
  RESEND_API_KEY?: string;
  FROM_EMAIL?: string;
  APP_ORIGIN?: string;
  ANTHROPIC_API_KEY?: string;
};

function unavailable(): Hono {
  const app = new Hono();
  app.all("*", (c) => c.json({ ok: false, error: "service unavailable" }, 503));
  return app;
}

export async function buildServerlessApp(env: ServerlessEnv): Promise<Hono> {
  const dbUrl = env.DATABASE_URL?.trim();
  const resendKey = env.RESEND_API_KEY?.trim();
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  const appOrigin = env.APP_ORIGIN?.replace(/\/$/, "").trim();
  if (!dbUrl || !resendKey || !apiKey || !appOrigin) return unavailable();

  try {
    const parsedOrigin = new URL(appOrigin);
    if (parsedOrigin.protocol !== "https:") return unavailable();
  } catch { return unavailable(); }

  const store = PostgresAuthStore.connect(dbUrl);
  await store.ensureSchema();
  const fromEmail = env.FROM_EMAIL ?? "Clay <login@example.com>";
  const app = createApp({
    apiKey,
    allowedOrigins: [appOrigin],
    auth: {
      store,
      sessions: new PgSessions(store.db),
      devLinks: false,
      sendEmail: async (email, link) => {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${resendKey}`,
          },
          body: JSON.stringify({
            from: fromEmail,
            to: [email],
            subject: "Your Clay sign-in link",
            text: `Sign in to Clay: ${appOrigin}${link}\n\n`
              + "The link works once and expires in 15 minutes.",
          }),
        });
        if (!res.ok) throw new Error(`resend ${res.status}`);
      },
    },
  });

  const outer = new Hono();
  outer.route("/", app);
  outer.route("/api", app);
  return outer;
}

let ready: Promise<Hono> | null = null;

export default async function handler(req: Request): Promise<Response> {
  ready ??= buildServerlessApp(process.env);
  return handle(await ready)(req);
}
