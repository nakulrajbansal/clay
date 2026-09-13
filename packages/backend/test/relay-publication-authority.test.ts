import { expect, it } from "vitest";
import { createApp, makeDevAuth } from "../src/app";
import { MemoryIntakeRelayStore } from "../src/intake-relay";

it.each(["/shares", "/intake/forms"])("denies %s allocation without account authority and an exact configured origin", async path => {
  const options = { intakeRelay: new MemoryIntakeRelayStore() };
  const request = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
  expect((await createApp(options).request(path, request)).status).toBe(401);
  const auth = makeDevAuth(); const user = await auth.store.upsertUser("owned-relay@example.test"); const session = await auth.sessions.createSession(user.id);
  const headers = { ...request.headers, authorization: `Bearer ${session}`, origin: "https://owner.example.test" };
  expect((await createApp({ ...options, auth }).request(path, { ...request, headers })).status).toBe(403);
  const app = createApp({ ...options, auth, allowedOrigins: [headers.origin] });
  expect((await app.request(path, { ...request, headers: { ...headers, origin: "https://other.example.test" } })).status).toBe(403);
  expect((await app.request(path, { ...request, headers })).status).toBe(400); // Now reaches closed input validation.
});
