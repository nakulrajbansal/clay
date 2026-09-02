// Vercel serverless entry (same-origin deploy). Production configuration is
// deliberately fail-closed: no database, email delivery, app origin, or model
// key means no mutation proxy and no dev magic links.
import { Hono } from "hono";
import { handle } from "hono/vercel";
import { createApp } from "../packages/backend/src/app";
import { PgSessions, PostgresAuthStore } from "../packages/backend/src/pg-store";
import { resolveProductionConfig } from "../packages/backend/src/model-config";

export type ServerlessEnv = {
  DATABASE_URL?: string;
  RESEND_API_KEY?: string;
  FROM_EMAIL?: string;
  APP_ORIGIN?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  MODEL_PROVIDER?: string;
  AUTH?: string;
};

function unavailable(): Hono {
  const app = new Hono();
  app.all("*", (c) => c.json({ ok: false, error: "service unavailable" }, 503));
  return app;
}

export async function buildServerlessApp(env: ServerlessEnv): Promise<Hono> {
  let config;
  try { config = resolveProductionConfig(env); }
  catch { return unavailable(); }

  const store = PostgresAuthStore.connect(config.databaseUrl);
  await store.ensureSchema();
  const app = createApp({
    model: config.model,
    allowedOrigins: [config.appOrigin],
    auth: {
      store,
      sessions: new PgSessions(store.db),
      devLinks: false,
      sendEmail: async (email, link) => {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.resendApiKey}`,
          },
          body: JSON.stringify({
            from: config.fromEmail,
            to: [email],
            subject: "Your Clay sign-in link",
            text: `Sign in to Clay: ${config.appOrigin}${link}\n\n`
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
