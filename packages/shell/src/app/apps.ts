// Presentation cache of the worker-owned durable app catalog. The worker boot
// response replaces this whole cache; it is never a source of target authority.
export type AppEntry = { id: string; name: string; shellId: string };

const APPS_KEY = "clay_apps";
const CURRENT_KEY = "clay_current_app";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch { return fallback; }
}

export function listApps(): AppEntry[] {
  return readJson<AppEntry[]>(APPS_KEY, []);
}

export function currentAppId(): string | null {
  return localStorage.getItem(CURRENT_KEY);
}

export function currentApp(): AppEntry | null {
  const id = currentAppId();
  return id ? listApps().find(a => a.id === id) ?? null : null;
}

function saveApps(apps: AppEntry[]): void {
  localStorage.setItem(APPS_KEY, JSON.stringify(apps));
}

export function replaceAppCache(apps: readonly AppEntry[], selectedId: string): void {
  const copy = apps.map(app => ({ ...app }));
  if (!copy.some(app => app.id === selectedId))
    throw new Error("catalog projection does not contain selected app");
  saveApps(copy);
  setCurrentApp(selectedId);
}

export function updateCachedApp(id: string, name: string, shellId: string): AppEntry {
  const current = listApps();
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || name.trim() === "" || name.length > 80
      || shellId.trim() === "" || current.filter(app => app.id === id).length !== 1)
    throw new Error("cached app update is invalid");
  const entry = { id, name, shellId };
  saveApps(current.map(app => app.id === id ? entry : app));
  setCurrentApp(id);
  return { ...entry };
}

export function setCurrentApp(id: string): void {
  localStorage.setItem(CURRENT_KEY, id);
}

function uuid(): string {
  return (crypto.randomUUID?.() ?? `app-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .replace(/[^a-zA-Z0-9_-]/g, "");
}

/** Create a new app entry and make it current. Returns it (unseeded). The
 * first app uses the legacy "default" id (files /user.db) so a brand-new
 * user and an existing single-app user share one storage layout. */
export function createApp(name: string, shellId: string): AppEntry {
  const id = listApps().length === 0 ? "default" : uuid();
  const entry: AppEntry = { id, name, shellId };
  saveApps([...listApps(), entry]);
  setCurrentApp(entry.id);
  return entry;
}

/** Cache a worker-published identity without minting or rebinding it. The two
 * localStorage keys are presentation hints only, but a failed cache update is
 * rolled back so retry cannot observe a half-written duplicate. */
export function cachePublishedApp(entry: AppEntry): AppEntry {
  if (!entry || typeof entry.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(entry.id)
      || typeof entry.name !== "string" || entry.name.trim() === "" || entry.name.length > 80
      || typeof entry.shellId !== "string" || entry.shellId.trim() === "")
    throw new Error("published app binding is invalid");
  const current = listApps();
  const duplicates = current.filter(candidate => candidate.id === entry.id);
  if (duplicates.length > 1) throw new Error("published app binding is ambiguous");
  const existing = duplicates[0];
  if (existing && (existing.name !== entry.name || existing.shellId !== entry.shellId))
    throw new Error("published app binding conflicts with the local cache");
  const next = existing ? current : [...current, { ...entry }];
  const previousApps = localStorage.getItem(APPS_KEY);
  const previousCurrent = localStorage.getItem(CURRENT_KEY);
  try {
    saveApps(next);
    setCurrentApp(entry.id);
  } catch (error) {
    try {
      if (previousApps === null) localStorage.removeItem(APPS_KEY);
      else localStorage.setItem(APPS_KEY, previousApps);
      if (previousCurrent === null) localStorage.removeItem(CURRENT_KEY);
      else localStorage.setItem(CURRENT_KEY, previousCurrent);
    } catch { /* cache remains nonauthoritative; worker read-back wins */ }
    throw error;
  }
  return { ...entry };
}

/** Register a forked copy with a fresh id and make it current. Always a uuid
 * (a fork is never the first app), so its OPFS files are its own. */
export function addForkEntry(name: string, shellId: string): AppEntry {
  const entry: AppEntry = { id: uuid(), name, shellId };
  saveApps([...listApps(), entry]);
  setCurrentApp(entry.id);
  return entry;
}

export function renameApp(id: string, name: string): void {
  saveApps(listApps().map(a => (a.id === id ? { ...a, name } : a)));
}

/** Remove an app from the registry. Returns the id to switch to (another
 * app), or null if none remain. Does NOT delete OPFS files — the caller
 * asks the worker to do that. */
export function removeApp(id: string): string | null {
  const remaining = listApps().filter(a => a.id !== id);
  saveApps(remaining);
  if (currentAppId() === id) {
    const next = remaining[0]?.id ?? null;
    if (next) setCurrentApp(next);
    else localStorage.removeItem(CURRENT_KEY);
    return next;
  }
  return currentAppId();
}

/**
 * Migration for existing single-app users: if there's persisted data under
 * the legacy files but no registry yet, adopt it as the "default" app so it
 * appears in the switcher instead of vanishing.
 */
export function ensureLegacyAdopted(seeded: boolean, shellId: string | null): void {
  if (listApps().length > 0) return;
  if (!seeded) return;
  const entry: AppEntry = { id: "default", name: shellName(shellId), shellId: shellId ?? "tracker" };
  saveApps([entry]);
  setCurrentApp("default");
}

export function shellName(shellId: string | null): string {
  const map: Record<string, string> = {
    blank: "My app", tracker: "Tracker", log: "Log", dashboard: "Dashboard",
    small_business: "Small Business", crm: "Sales CRM",
    financials: "Bookkeeping", staff: "Staff & Scheduling", habits: "Habits", inventory: "Inventory",
  };
  return (shellId && map[shellId]) || "My app";
}

/** Name a blank app from its first kept summary: "Creates a Portfolio
 * Dashboard with projects and a status board." -> "Portfolio Dashboard".
 * Returns null when nothing name-worthy survives the trimming. */
export function deriveAppName(summary: string): string | null {
  let s = summary.trim()
    .replace(/^(creates?|builds?|adds?|sets up|starts?|makes?)\s+/i, "")
    .replace(/^(your?|a|an|the)\s+/i, "");
  // cut at the first connective — the head noun phrase IS the name
  s = s.split(/[,:;.]|\s+(?:with|for|that|showing|tracking|to|and)\s+/i)[0] ?? "";
  const words = s.trim().split(/\s+/).filter(Boolean).slice(0, 4);
  if (words.length === 0) return null;
  const name = words.join(" ").replace(/\W+$/, "");
  if (name.length < 3) return null;
  return (name[0]!.toUpperCase() + name.slice(1)).slice(0, 30);
}
