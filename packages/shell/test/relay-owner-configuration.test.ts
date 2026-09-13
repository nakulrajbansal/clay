/** @vitest-environment jsdom */
/** @vitest-environment-options {"url":"https://app.example.test"} */
import { afterEach, expect, it, vi } from "vitest";
import { getRelayOwnerUrl, ownerIntakeFetch } from "../src/intake/relay-owner-configuration";
import { setBackendUrl, setSessionToken, setAmbientSessionAllowed } from "../src/app/settings";

afterEach(() => localStorage.clear()); // Owned jsdom profile, never host storage.
it("requires explicit origin-bound owner session authority instead of guessing a relay", () => {
  expect(getRelayOwnerUrl()).toBeNull(); setBackendUrl("https://relay.example.test"); expect(getRelayOwnerUrl()).toBeNull();
  setAmbientSessionAllowed(true, "https://relay.example.test"); expect(getRelayOwnerUrl()).toBe("https://relay.example.test");
  setBackendUrl("https://another.example.test"); expect(getRelayOwnerUrl()).toBeNull();
});
it("hydrates session credentials only for registration at the approved relay and preserves specific owner capabilities", async () => {
  setBackendUrl("https://relay.example.test"); setSessionToken("owned-fixture", "https://relay.example.test");
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 })); const send = ownerIntakeFetch("https://relay.example.test/", fetcher);
  await send("https://relay.example.test/intake/forms", { method: "POST", body: "{}" });
  expect(new Headers(fetcher.mock.calls[0]![1]?.headers).has("authorization")).toBe(true);
  await send("https://relay.example.test/intake/forms/form_aaaaaaaaaaaaaaaaaaaaaaaaaa", { method: "DELETE", headers: { authorization: "Bearer owned-specific-capability" } });
  expect(new Headers(fetcher.mock.calls[1]![1]?.headers).get("authorization") === "Bearer owned-specific-capability").toBe(true);
  await expect(send("https://other.example.test/intake/forms", { method: "POST" })).rejects.toThrow(/origin/);
  expect(fetcher).toHaveBeenCalledTimes(2);
  setSessionToken(null); await expect(send("https://relay.example.test/intake/forms", { method: "POST" })).rejects.toThrow(/authority/);
});
