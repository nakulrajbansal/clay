export const DAILY_NAVIGATION_SETTING = "daily_navigation_v1";
const TABLE_ID = /^tbl_[0-9a-f]{8}-[0-9a-f]{4}-[17][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[17][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_FAVORITES = 50;
const MAX_RECENTS = 20;

export type DailyRecordReference = Readonly<{
  tableId: string;
  rowId: string;
}>;
export type DailyFavoriteReference = DailyRecordReference & Readonly<{ pinnedAt: string }>;
export type DailyRecentReference = DailyRecordReference & Readonly<{ openedAt: string }>;
export type DailyNavigationState = Readonly<{
  schema: 1;
  revision: number;
  favorites: readonly DailyFavoriteReference[];
  recents: readonly DailyRecentReference[];
}>;

export type DailyNavigationStorage = {
  getSetting<T>(key: string): Promise<T | null | undefined>;
  compareAndSetDailyNavigation<T>(
    expectedRevision: number,
    value: T,
  ): Promise<{ ok: boolean; current: unknown }>;
};

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === [...expected].sort()[index]);
}

function instant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { return new Date(value).toISOString() === value; }
  catch { return false; }
}

function target(value: unknown, timeKey: "pinnedAt" | "openedAt"):
DailyFavoriteReference | DailyRecentReference | null {
  if (typeof value !== "object" || value === null
      || !exactKeys(value, ["tableId", "rowId", timeKey])) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.tableId !== "string" || !TABLE_ID.test(candidate.tableId)
      || typeof candidate.rowId !== "string" || !ROW_ID.test(candidate.rowId)
      || !instant(candidate[timeKey])) return null;
  return Object.freeze({
    tableId: candidate.tableId,
    rowId: candidate.rowId,
    [timeKey]: candidate[timeKey],
  }) as DailyFavoriteReference | DailyRecentReference;
}

function emptyState(): DailyNavigationState {
  return Object.freeze({
    schema: 1 as const,
    revision: 0,
    favorites: Object.freeze([]) as readonly DailyFavoriteReference[],
    recents: Object.freeze([]) as readonly DailyRecentReference[],
  });
}

export function loadDailyNavigationState(input: unknown): DailyNavigationState {
  if (input === null || input === undefined) return emptyState();
  if (typeof input !== "object" || !exactKeys(input, ["schema", "revision", "favorites", "recents"]))
    throw new TypeError("invalid Daily Home navigation state");
  const value = input as Record<string, unknown>;
  if (value.schema !== 1 || !Number.isSafeInteger(value.revision)
      || (value.revision as number) < 0
      || !Array.isArray(value.favorites) || value.favorites.length > MAX_FAVORITES
      || !Array.isArray(value.recents) || value.recents.length > MAX_RECENTS) {
    throw new TypeError("invalid Daily Home navigation state");
  }
  const favorites = value.favorites.map(item => target(item, "pinnedAt"));
  const recents = value.recents.map(item => target(item, "openedAt"));
  if (favorites.some(item => item === null) || recents.some(item => item === null))
    throw new TypeError("invalid Daily Home navigation state");
  const unique = (items: readonly (DailyRecordReference | null)[]): boolean => {
    const keys = items.map(item => `${item!.tableId}\u0000${item!.rowId}`);
    return new Set(keys).size === keys.length;
  };
  if (!unique(favorites) || !unique(recents))
    throw new TypeError("invalid Daily Home navigation state");
  return Object.freeze({
    schema: 1 as const,
    revision: value.revision as number,
    favorites: Object.freeze(favorites as DailyFavoriteReference[]),
    recents: Object.freeze(recents as DailyRecentReference[]),
  });
}

function validateReference(reference: DailyRecordReference): void {
  if (!TABLE_ID.test(reference.tableId) || !ROW_ID.test(reference.rowId))
    throw new TypeError("invalid Daily Home record reference");
}

function nowInstant(now: () => string): string {
  const value = now();
  if (!instant(value)) throw new TypeError("Daily Home clock returned a non-canonical instant");
  return value;
}

async function updateState(
  storage: DailyNavigationStorage,
  mutate: (current: DailyNavigationState) => Omit<DailyNavigationState, "revision">,
): Promise<DailyNavigationState> {
  let raw: unknown = await storage.getSetting<unknown>(DAILY_NAVIGATION_SETTING);
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = loadDailyNavigationState(raw);
    const changed = mutate(current);
    const next = loadDailyNavigationState({ ...changed, revision: current.revision + 1 });
    const result = await storage.compareAndSetDailyNavigation(
      current.revision, next,
    );
    if (result.ok) return next;
    raw = result.current;
  }
  throw new Error("Daily Home navigation changed in another window; try again");
}

export async function rememberDailyRecordOpened(
  storage: DailyNavigationStorage,
  reference: DailyRecordReference,
  now: () => string = () => new Date().toISOString(),
): Promise<DailyNavigationState> {
  validateReference(reference);
  const openedAt = nowInstant(now);
  return updateState(storage, current => ({
    schema: 1,
    favorites: current.favorites,
    recents: Object.freeze([
      Object.freeze({ ...reference, openedAt }),
      ...current.recents.filter(item =>
        item.tableId !== reference.tableId || item.rowId !== reference.rowId),
    ].slice(0, MAX_RECENTS)),
  }));
}

export async function toggleDailyFavorite(
  storage: DailyNavigationStorage,
  reference: DailyRecordReference,
  now: () => string = () => new Date().toISOString(),
): Promise<Readonly<{ state: DailyNavigationState; favorite: boolean }>> {
  validateReference(reference);
  const pinnedAt = nowInstant(now);
  let favorite = false;
  const state = await updateState(storage, current => {
    const exists = current.favorites.some(item =>
      item.tableId === reference.tableId && item.rowId === reference.rowId);
    favorite = !exists;
    return {
      schema: 1,
      favorites: exists
        ? current.favorites.filter(item =>
            item.tableId !== reference.tableId || item.rowId !== reference.rowId)
        : Object.freeze([
            Object.freeze({ ...reference, pinnedAt }),
            ...current.favorites,
          ].slice(0, MAX_FAVORITES)),
      recents: current.recents,
    };
  });
  return Object.freeze({ state, favorite });
}
