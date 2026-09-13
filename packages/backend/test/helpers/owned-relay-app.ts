import { createApp, makeDevAuth, type BackendOptions } from "../../src/app";

/** Explicit owned account + origin fixture. No production bypass or environment
 * switch: requests execute the same default-denied publication middleware. */
export function ownedRelayApp(options: BackendOptions): ReturnType<typeof createApp> {
  const auth = options.auth ?? makeDevAuth();
  const app = createApp({ ...options, auth, allowedOrigins: options.allowedOrigins ?? ["https://owner.example"] });
  const raw = app.request.bind(app);
  const session = options.auth ? Promise.resolve(null) : auth.store.upsertUser("owned-relay@example.test").then(user => auth.sessions.createSession(user.id));
  app.request = (async (input: Parameters<typeof app.request>[0], init?: RequestInit, ...rest: unknown[]) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has("origin")) headers.set("origin", "https://owner.example");
    const token = await session;
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    if (token && !headers.has("authorization") && /\/(?:shares|intake\/forms)$/.test(url)) headers.set("authorization", `Bearer ${token}`);
    return raw(input, { ...init, headers }, ...rest);
  }) as typeof app.request;
  return app;
}
