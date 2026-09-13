// Presentation cache of the worker-owned durable app catalog. The worker boot
// response replaces this whole cache; it never creates, selects, renames, or
// deletes a durable identity.
export type AppEntry = { id: string; name: string; shellId: string };

const APPS_KEY = "clay_apps";
const CURRENT_KEY = "clay_current_app";
const CANONICAL_APP_ID = /^app_[a-z2-7]{26}$/;

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
  return id ? listApps().find(app => app.id === id) ?? null : null;
}

/** Replace presentation state only from a validated worker projection. */
export function replaceAppCache(apps: readonly AppEntry[], selectedId: string): void {
  const copy = apps.map(app => ({ ...app }));
  if (!CANONICAL_APP_ID.test(selectedId)
      || copy.length < 1 || copy.length > 1_000
      || new Set(copy.map(app => app.id)).size !== copy.length
      || copy.some(app => !CANONICAL_APP_ID.test(app.id)
        || app.name !== app.name.trim() || app.name.length < 1 || app.name.length > 40
        || !/^[a-z0-9_-]{1,64}$/.test(app.shellId))
      || !copy.some(app => app.id === selectedId))
    throw new Error("catalog projection does not contain a valid selected app");
  localStorage.setItem(APPS_KEY, JSON.stringify(copy));
  localStorage.setItem(CURRENT_KEY, selectedId);
}

export function shellName(shellId: string | null): string {
  const map: Record<string, string> = {
    blank: "My app", tracker: "Tracker", log: "Log", dashboard: "Dashboard",
    small_business: "Small Business", crm: "Sales CRM",
    financials: "Bookkeeping", staff: "Staff & Scheduling", habits: "Habits", inventory: "Inventory",
  };
  return (shellId && map[shellId]) || "My app";
}

/** Name a blank app from its first kept summary. */
export function deriveAppName(summary: string): string | null {
  let value = summary.trim()
    .replace(/^(creates?|builds?|adds?|sets up|starts?|makes?)\s+/i, "")
    .replace(/^(your?|a|an|the)\s+/i, "");
  value = value.split(/[,:;.]|\s+(?:with|for|that|showing|tracking|to|and)\s+/i)[0] ?? "";
  const words = value.trim().split(/\s+/).filter(Boolean).slice(0, 4);
  if (words.length === 0) return null;
  const name = words.join(" ").replace(/\W+$/, "");
  if (name.length < 3) return null;
  return (name[0]!.toUpperCase() + name.slice(1)).slice(0, 30);
}
