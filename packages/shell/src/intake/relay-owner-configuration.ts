import { getBackendUrl, getSessionToken, isAmbientSessionAllowed } from "../app/settings";

/** A backend URL guessed for managed model access is not relay publication
 * authority. Only an explicitly origin-bound session/ambient grant enables it. */
export function getRelayOwnerUrl(): string | null {
  const base = getBackendUrl();
  return base && (isAmbientSessionAllowed(base) || getSessionToken(base) !== null) ? base : null;
}
/** Private credentials are hydrated at the last trusted-shell HTTP boundary,
 * never persisted in a form intent or passed to WorkerClient. */
export function ownerIntakeFetch(base: string, fetcher: typeof fetch = fetch): typeof fetch {
  const origin = new URL(base).origin;
  return async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (url.origin !== origin || url.username || url.password || url.hash || !url.pathname.startsWith("/intake/forms")) throw new Error("Intake HTTP origin is not authorized");
    const headers = new Headers(init?.headers); const registration = url.pathname === "/intake/forms" && init?.method === "POST";
    let credentials: RequestCredentials = "omit";
    if (registration) {
      const token = getSessionToken(base), ambient = isAmbientSessionAllowed(base);
      if (!token && !ambient) throw new Error("Sign in to establish original relay publisher authority");
      if (token) headers.set("authorization", `Bearer ${token}`);
      if (ambient) credentials = "include";
    } else if (!headers.has("authorization")) throw new Error("Specific intake owner authority is required");
    return fetcher(input, { ...init, headers, credentials, redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" });
  };
}
