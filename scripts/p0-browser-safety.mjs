import { randomUUID } from "node:crypto";

const ownedContexts = new WeakMap();
const origin = "http://127.0.0.1:4181";
export function assertTestOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("P0 requires an owned loopback origin"); }
  if (parsed.origin !== origin || parsed.username || parsed.password || parsed.pathname !== "/"
      || parsed.search || parsed.hash) throw new Error("P0 requires the exact owned loopback origin http://127.0.0.1:4181");
  return origin;
}
export function rejectExternalBrowser(env) {
  if (env.PLAYWRIGHT_CDP_URL) throw new Error("P0 refuses external CDP: never attach to or clear an existing browser context");
  if (env.URL) throw new Error("P0 refuses an external preview: the gate must build and serve its own source");
  if (env.PORT && env.PORT !== "4181") throw new Error("P0 requires the owned loopback preview on port 4181");
}
/** Called only for a freshly-created context in the gate-owned browser. No storage reset exists here. */
export async function markOwnedContext(context) {
  const marker = `clay-disposable-p0:${randomUUID()}`;
  await context.addInitScript(value => {
    Object.defineProperty(globalThis, "__clayDisposableP0", { value, configurable: false });
  }, marker);
  ownedContexts.set(context, marker);
  return marker;
}
export async function assertOwnedPage(page) {
  const marker = ownedContexts.get(page.context());
  if (!marker) throw new Error("not an owned disposable P0 context");
  assertTestOrigin(new URL(page.url()).origin);
  if (await page.evaluate(() => globalThis.__clayDisposableP0) !== marker)
    throw new Error("P0 disposable marker is absent or mismatched");
}
