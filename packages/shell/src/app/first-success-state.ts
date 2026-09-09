import {
  FIRST_SUCCESS_SETTING_KEY,
  applyFirstSuccessEvent,
  emptyFirstSuccessState,
  firstSuccessCount,
  parseFirstSuccessState,
  reconcileFirstSuccessAfterImportUndo,
  type FirstSuccessEvent,
  type FirstSuccessState,
} from "@clay/kernel/first-success";

export {
  FIRST_SUCCESS_SETTING_KEY,
  applyFirstSuccessEvent,
  emptyFirstSuccessState,
  firstSuccessCount,
  parseFirstSuccessState,
  reconcileFirstSuccessAfterImportUndo,
};
export type { FirstSuccessEvent, FirstSuccessState };

export const FIRST_WRITE_STORAGE_COPY =
  "Records are stored in this browser on this device. Clearing this browser’s site data can remove them.";
export const TEMPORARY_FIRST_WRITE_COPY =
  "This is a temporary session. Records can disappear when this tab closes.";

export type ShellFirstSuccessEvent = Exclude<FirstSuccessEvent, { type: "everyday_action" }>;

export type FirstSuccessSettingClient = {
  getSetting: (key: string) => Promise<unknown>;
  compareAndSetSetting: (
    key: string, expectedRevision: number, value: FirstSuccessState,
  ) => Promise<{ ok: boolean; current: unknown }>;
};

export async function loadFirstSuccessState(
  client: FirstSuccessSettingClient,
): Promise<FirstSuccessState> {
  const value = await client.getSetting(FIRST_SUCCESS_SETTING_KEY);
  return value === null || value === undefined ? emptyFirstSuccessState() : parseFirstSuccessState(value);
}

export async function mutateFirstSuccessState(
  client: FirstSuccessSettingClient,
  event: ShellFirstSuccessEvent,
  maxAttempts = 4,
): Promise<FirstSuccessState> {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8)
    throw new Error("First-success retry limit is invalid");
  let current = await loadFirstSuccessState(client);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const applied = applyFirstSuccessEvent(current, event);
    if (applied === current) return current;
    if (current.revision >= Number.MAX_SAFE_INTEGER)
      throw new Error("First-success progress revision cannot advance");
    const next: FirstSuccessState = { ...applied, revision: current.revision + 1 };
    const result = await client.compareAndSetSetting(
      FIRST_SUCCESS_SETTING_KEY, current.revision, next,
    );
    if (result.ok) return parseFirstSuccessState(result.current ?? next);
    current = result.current === null || result.current === undefined
      ? emptyFirstSuccessState() : parseFirstSuccessState(result.current);
  }
  throw new Error("Setup progress changed in another view. Try again.");
}
