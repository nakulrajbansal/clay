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

function setCurrentApp(id: string): void {
  localStorage.setItem(CURRENT_KEY, id);
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
