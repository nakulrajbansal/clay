import { describe, expect, it } from "vitest";
import {
  resolveModelConfig, resolveProductionConfig, type ProductionEnv,
} from "../src/model-config";

const production: ProductionEnv = {
  DATABASE_URL: "postgresql://user:pass@db.example/clay",
  RESEND_API_KEY: "resend-test",
  FROM_EMAIL: "Clay <login@clay.example>",
  APP_ORIGIN: "https://clay.example",
  MODEL_PROVIDER: "openai",
  OPENAI_API_KEY: "openai-test",
};

describe("resolveModelConfig", () => {
  it("selects OpenAI Responses explicitly", () => {
    expect(resolveModelConfig({
      MODEL_PROVIDER: "openai", OPENAI_API_KEY: "openai-test", OPENAI_MODEL: "gpt-test",
    })).toEqual({ provider: "openai", apiKey: "openai-test", model: "gpt-test" });
  });

  it("preserves Anthropic as the compatibility default", () => {
    expect(resolveModelConfig({ ANTHROPIC_API_KEY: "anthropic-test" }))
      .toMatchObject({ provider: "anthropic", apiKey: "anthropic-test" });
  });

  it("fails closed when the selected provider has no credential", () => {
    expect(() => resolveModelConfig({ MODEL_PROVIDER: "openai" }))
      .toThrow(/OPENAI_API_KEY/);
    expect(() => resolveModelConfig({
      MODEL_PROVIDER: "openai", OPENAI_API_KEY: "   ",
    })).toThrow(/OPENAI_API_KEY/);
    expect(() => resolveModelConfig({ ANTHROPIC_API_KEY: "\t" }))
      .toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe("resolveProductionConfig", () => {
  it("returns one normalized fail-closed production configuration", () => {
    expect(resolveProductionConfig(production)).toMatchObject({
      databaseUrl: production.DATABASE_URL,
      resendApiKey: production.RESEND_API_KEY,
      fromEmail: production.FROM_EMAIL,
      appOrigin: production.APP_ORIGIN,
      model: { provider: "openai" },
    });
  });

  for (const key of ["DATABASE_URL", "RESEND_API_KEY", "FROM_EMAIL", "APP_ORIGIN"] as const) {
    it(`rejects production with no ${key}`, () => {
      expect(() => resolveProductionConfig({ ...production, [key]: undefined }))
        .toThrow(new RegExp(key));
    });
  }

  it.each([
    [{ ...production, AUTH: "dev" }, /AUTH=dev/],
    [{ ...production, DATABASE_URL: "https://db.example" }, /postgres/],
    [{ ...production, APP_ORIGIN: "http://clay.example" }, /HTTPS/],
    [{ ...production, APP_ORIGIN: "https://clay.example/path" }, /bare HTTPS/],
    [{ ...production, FROM_EMAIL: "not-an-email" }, /FROM_EMAIL/],
    [{ ...production, OPENAI_API_KEY: undefined }, /OPENAI_API_KEY/],
  ] as const)("rejects malformed production input %#", (env, message) => {
    expect(() => resolveProductionConfig(env)).toThrow(message);
  });
});
