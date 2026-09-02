import { DEFAULT_MODEL, DEFAULT_OPENAI_MODEL } from "@clay/mutation";
import type { ModelConfig, ModelProvider } from "./app";

export type ModelEnv = Partial<Record<
  "MODEL_PROVIDER" | "ANTHROPIC_API_KEY" | "ANTHROPIC_MODEL" |
  "OPENAI_API_KEY" | "OPENAI_MODEL",
  string
>>;

export type ProductionEnv = ModelEnv & Partial<Record<
  "DATABASE_URL" | "RESEND_API_KEY" | "FROM_EMAIL" | "APP_ORIGIN" | "AUTH",
  string
>>;

export type ProductionConfig = {
  model: ModelConfig;
  databaseUrl: string;
  resendApiKey: string;
  fromEmail: string;
  appOrigin: string;
};

export function resolveModelConfig(env: ModelEnv): ModelConfig {
  const provider = (env.MODEL_PROVIDER?.trim() || "anthropic") as ModelProvider;
  if (provider === "openai") {
    const apiKey = env.OPENAI_API_KEY?.trim();
    if (!apiKey) throw new Error("OPENAI_API_KEY is required for MODEL_PROVIDER=openai");
    return { provider, apiKey,
      model: env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL };
  }
  if (provider !== "anthropic")
    throw new Error(`MODEL_PROVIDER '${provider}' is not supported by the hosted backend`);
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required for MODEL_PROVIDER=anthropic");
  return { provider, apiKey,
    model: env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL };
}

export function resolveProductionConfig(env: ProductionEnv): ProductionConfig {
  if (env.AUTH === "dev") throw new Error("AUTH=dev is forbidden in production");
  const databaseUrl = env.DATABASE_URL?.trim();
  const resendApiKey = env.RESEND_API_KEY?.trim();
  const fromEmail = env.FROM_EMAIL?.trim();
  const rawOrigin = env.APP_ORIGIN?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required in production");
  if (!resendApiKey) throw new Error("RESEND_API_KEY is required in production");
  if (!fromEmail || !/(?:<)?[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>?$/.test(fromEmail))
    throw new Error("FROM_EMAIL must contain a valid sender address");
  let database: URL;
  try { database = new URL(databaseUrl); }
  catch { throw new Error("DATABASE_URL must be a valid postgres URL"); }
  if (database.protocol !== "postgres:" && database.protocol !== "postgresql:")
    throw new Error("DATABASE_URL must use postgres or postgresql");
  let origin: URL;
  try { origin = new URL(rawOrigin ?? ""); }
  catch { throw new Error("APP_ORIGIN must be a valid HTTPS origin"); }
  if (origin.protocol !== "https:" || origin.username || origin.password
      || origin.search || origin.hash || (origin.pathname !== "/" && origin.pathname !== ""))
    throw new Error("APP_ORIGIN must be a bare HTTPS origin");
  return {
    model: resolveModelConfig(env), databaseUrl, resendApiKey, fromEmail,
    appOrigin: origin.origin,
  };
}
