// The multi-app registry (G4): the list of apps the user has, and which is
// current, kept in localStorage on the MAIN thread (the worker has no
// localStorage). Switching is reload-based — set current, reload, and boot
// opens that app's namespaced OPFS files. Data lives per-app in OPFS; this
// is just the lightweight index.
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
    tracker: "Tracker", log: "Log", dashboard: "Dashboard",
    small_business: "Small Business", crm: "Sales CRM",
    financials: "Bookkeeping", staff: "Staff & Scheduling",
  };
  return (shellId && map[shellId]) || "My app";
}
