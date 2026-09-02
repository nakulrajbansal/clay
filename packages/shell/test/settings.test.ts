// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  CODEX_BACKEND_URL, getActiveModelAccess, getModelProvider, getSessionToken,
  hasModelAccess,
  normalizeBackendUrl, setApiKey, setBackendUrl, setModelProvider,
  setSessionToken,
} from "../src/app/settings";

describe("model provider settings", () => {
  beforeEach(() => localStorage.clear());

  it("uses the local Codex connector without a browser API key", () => {
    setModelProvider("codex");
    expect(getModelProvider()).toBe("codex");
    expect(getActiveModelAccess()).toEqual({ provider: "codex",
      apiKey: null, backendUrl: CODEX_BACKEND_URL });
    expect(hasModelAccess()).toBe(true);
  });

  it("activates only the selected provider credential path", () => {
    setApiKey("anthropic-test");
    setBackendUrl("http://127.0.0.1:8787");

    setModelProvider("anthropic");
    expect(getActiveModelAccess()).toEqual({ provider: "anthropic",
      apiKey: "anthropic-test", backendUrl: null });

    setModelProvider("openai");
    expect(getActiveModelAccess()).toEqual({ provider: "openai",
      apiKey: null, backendUrl: "http://127.0.0.1:8787" });
  });

  it("accepts secure or loopback Clay backends and rejects credential-bearing URLs", () => {
    expect(normalizeBackendUrl("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(normalizeBackendUrl("https://models.example.com/clay/")).toBe("https://models.example.com/clay");
    expect(() => normalizeBackendUrl("http://models.example.com")).toThrow(/HTTPS/);
    expect(() => normalizeBackendUrl("https://user:pass@models.example.com")).toThrow(/credentials/);
    expect(() => normalizeBackendUrl("https://api.openai.com/v1")).toThrow(/Clay model backend/);
    expect(() => normalizeBackendUrl("http://127.attacker.example:8787")).toThrow(/HTTPS/);
    expect(() => normalizeBackendUrl("http://127.0.0.1.attacker.example:8787")).toThrow(/HTTPS/);
  });

  it("preserves backend-first behavior while migrating legacy provider settings", () => {
    setApiKey("anthropic-test");
    setBackendUrl("https://models.example.com");
    expect(getModelProvider()).toBe("clay");
  });

  it("never sends or revokes a session at a different backend origin", () => {
    setBackendUrl("https://a.example/clay");
    setSessionToken("session-from-a");
    expect(getSessionToken()).toBe("session-from-a");
    expect(getSessionToken("https://b.example/clay")).toBeNull();

    setBackendUrl("https://b.example/clay");
    expect(getSessionToken()).toBeNull();
    expect(localStorage.getItem("clay_session")).toBeNull();
  });

  it("drops unbound legacy session strings instead of attaching them to a backend", () => {
    setBackendUrl("https://a.example");
    localStorage.setItem("clay_session", "legacy-unbound-token");
    expect(getSessionToken()).toBeNull();
    expect(localStorage.getItem("clay_session")).toBeNull();
  });
});
