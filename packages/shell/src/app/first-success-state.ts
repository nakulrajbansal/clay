import type { StarterShellId } from "../shells/seed";

export const FIRST_SUCCESS_SETTING_KEY = "release_a_first_success_v1";
export const FIRST_WRITE_STORAGE_COPY =
  "Records are stored in this browser on this device. Clearing this browser’s site data can remove them.";
export const TEMPORARY_FIRST_WRITE_COPY =
  "This is a temporary session. Records can disappear when this tab closes.";

type PendingEvidence = { state: "pending" };
type StartEvidence = PendingEvidence | {
  state: "complete";
  path: "recommended" | "import" | "gallery" | "blank";
  shellId: StarterShellId;
};
type RecordEvidence = PendingEvidence | {
  state: "complete";
  source: "create" | "import";
};
type EverydayEvidence = PendingEvidence | {
  state: "complete";
  action: "open" | "search" | "update" | "complete";
};
type PreviewEvidence = PendingEvidence | {
  state: "complete";
  baseVersion: number;
};
type KeptEvidence = PendingEvidence | {
  state: "complete";
  version: number;
};

/** Version 2 keeps app creation metadata outside the four user-success steps.
 * The setting key stays stable so existing per-app V1 progress can migrate. */
export type FirstSuccessState = {
  version: 2;
  revision: number;
  dismissed: boolean;
  start: StartEvidence;
  steps: {
    realRecord: RecordEvidence;
    everyday: EverydayEvidence;
    reshapePreview: PreviewEvidence;
    reshapeKept: KeptEvidence;
  };
};

type LegacyFirstSuccessState = {
  version: 1;
  revision: number;
  dismissed: boolean;
  steps: {
    app: StartEvidence;
    realRecord: RecordEvidence;
    work: PendingEvidence | { state: "complete" };
    customization: KeptEvidence;
  };
};

export type FirstSuccessEvent =
  | { type: "app_created"; path: "recommended" | "import" | "gallery" | "blank";
      shellId: StarterShellId }
  | { type: "real_record"; source: "create" | "import"; changed: number; sample: boolean }
  | { type: "everyday_action"; action: "open" | "search" | "update" | "complete";
      changed: boolean; sample: boolean }
  | { type: "reshape_previewed"; baseVersion: number }
  | { type: "reshape_kept"; version: number; changed: boolean }
  // Compatibility alias keeps older customization callers safe during migration.
  | { type: "customization_kept"; version: number; changed: boolean }
  | { type: "set_dismissed"; dismissed: boolean };

export type ShellFirstSuccessEvent = Exclude<FirstSuccessEvent, { type: "everyday_action" }>;

export type FirstSuccessSettingClient = {
  getSetting: (key: string) => Promise<unknown>;
  compareAndSetSetting: (
    key: string, expectedRevision: number, value: FirstSuccessState,
  ) => Promise<{ ok: boolean; current: unknown }>;
};

export function emptyFirstSuccessState(): FirstSuccessState {
  return {
    version: 2,
    revision: 0,
    dismissed: false,
    start: { state: "pending" },
    steps: {
      realRecord: { state: "pending" },
      everyday: { state: "pending" },
      reshapePreview: { state: "pending" },
      reshapeKept: { state: "pending" },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function pending(value: unknown): value is PendingEvidence {
  return isRecord(value) && value.state === "pending" && Object.keys(value).length === 1;
}

function validStart(value: unknown): value is StartEvidence {
  return pending(value) || (isRecord(value) && value.state === "complete"
    && hasExactKeys(value, ["path", "shellId", "state"])
    && ["recommended", "import", "gallery", "blank"].includes(String(value.path))
    && typeof value.shellId === "string" && value.shellId.length > 0 && value.shellId.length <= 40);
}

function validRecord(value: unknown): value is RecordEvidence {
  return pending(value) || (isRecord(value) && value.state === "complete"
    && hasExactKeys(value, ["source", "state"])
    && (value.source === "create" || value.source === "import"));
}

function validEveryday(value: unknown): value is EverydayEvidence {
  return pending(value) || (isRecord(value) && value.state === "complete"
    && hasExactKeys(value, ["action", "state"])
    && ["open", "search", "update", "complete"].includes(String(value.action)));
}

function validPreview(value: unknown): value is PreviewEvidence {
  return pending(value) || (isRecord(value) && value.state === "complete"
    && hasExactKeys(value, ["baseVersion", "state"])
    && Number.isSafeInteger(value.baseVersion) && Number(value.baseVersion) >= 0);
}

function validKept(value: unknown): value is KeptEvidence {
  return pending(value) || (isRecord(value) && value.state === "complete"
    && hasExactKeys(value, ["state", "version"])
    && Number.isSafeInteger(value.version) && Number(value.version) > 0);
}

function validEnvelope(value: Record<string, unknown>): boolean {
  return Number.isSafeInteger(value.revision) && Number(value.revision) >= 0
    && typeof value.dismissed === "boolean";
}

function parseLegacyFirstSuccessState(value: Record<string, unknown>): FirstSuccessState {
  if (!hasExactKeys(value, ["dismissed", "revision", "steps", "version"])
      || !validEnvelope(value) || !isRecord(value.steps)
      || !hasExactKeys(value.steps, ["app", "customization", "realRecord", "work"])
      || !validStart(value.steps.app) || !validRecord(value.steps.realRecord)
      || !(pending(value.steps.work) || (isRecord(value.steps.work)
        && value.steps.work.state === "complete" && hasExactKeys(value.steps.work, ["state"])))
      || !validKept(value.steps.customization))
    throw new Error("First-success progress is invalid");
  const legacy = value as unknown as LegacyFirstSuccessState;
  const kept = legacy.steps.customization;
  return {
    version: 2,
    revision: legacy.revision,
    dismissed: legacy.dismissed,
    start: legacy.steps.app,
    steps: {
      realRecord: legacy.steps.realRecord,
      everyday: legacy.steps.work.state === "complete"
        ? { state: "complete", action: "open" } : { state: "pending" },
      reshapePreview: kept.state === "complete"
        ? { state: "complete", baseVersion: Math.max(0, kept.version - 1) }
        : { state: "pending" },
      reshapeKept: kept,
    },
  };
}

export function parseFirstSuccessState(value: unknown): FirstSuccessState {
  if (!isRecord(value)) throw new Error("First-success progress is invalid");
  if (value.version === 1) return parseLegacyFirstSuccessState(value);
  if (value.version !== 2
      || !hasExactKeys(value, ["dismissed", "revision", "start", "steps", "version"])
      || !validEnvelope(value) || !validStart(value.start) || !isRecord(value.steps)
      || !hasExactKeys(value.steps, ["everyday", "realRecord", "reshapeKept", "reshapePreview"])
      || !validRecord(value.steps.realRecord) || !validEveryday(value.steps.everyday)
      || !validPreview(value.steps.reshapePreview) || !validKept(value.steps.reshapeKept))
    throw new Error("First-success progress is invalid");
  return value as FirstSuccessState;
}

/** Undo may remove the only canonical real-record evidence. Reconcile the
 * dependent milestones while preserving setup, reshape, and dismissal evidence. */
export function reconcileFirstSuccessAfterImportUndo(
  value: unknown,
  realRecordAvailable: boolean,
): FirstSuccessState {
  const state = parseFirstSuccessState(value);
  if (realRecordAvailable
      || (state.steps.realRecord.state === "pending" && state.steps.everyday.state === "pending"))
    return state;
  if (state.revision >= Number.MAX_SAFE_INTEGER)
    throw new Error("First-success progress revision cannot advance");
  return {
    ...state,
    revision: state.revision + 1,
    steps: {
      ...state.steps,
      realRecord: { state: "pending" },
      everyday: { state: "pending" },
    },
  };
}

export function applyFirstSuccessEvent(
  state: FirstSuccessState,
  event: FirstSuccessEvent,
): FirstSuccessState {
  switch (event.type) {
    case "app_created":
      if (state.start.state === "complete") return state;
      return { ...state,
        start: { state: "complete", path: event.path, shellId: event.shellId } };
    case "real_record":
      if (state.steps.realRecord.state === "complete"
          || event.sample || !Number.isSafeInteger(event.changed) || event.changed <= 0) return state;
      return { ...state, steps: { ...state.steps,
        realRecord: { state: "complete", source: event.source } } };
    case "everyday_action":
      if (state.steps.everyday.state === "complete" || state.steps.realRecord.state !== "complete"
          || event.sample || !event.changed) return state;
      return { ...state, steps: { ...state.steps,
        everyday: { state: "complete", action: event.action } } };
    case "reshape_previewed":
      if (state.steps.reshapePreview.state === "complete"
          || state.steps.everyday.state !== "complete"
          || !Number.isSafeInteger(event.baseVersion) || event.baseVersion < 0) return state;
      return { ...state, steps: { ...state.steps,
        reshapePreview: { state: "complete", baseVersion: event.baseVersion } } };
    case "reshape_kept":
    case "customization_kept":
      if (state.steps.reshapeKept.state === "complete"
          || state.steps.reshapePreview.state !== "complete" || !event.changed
          || !Number.isSafeInteger(event.version) || event.version <= 0) return state;
      return { ...state, steps: { ...state.steps,
        reshapeKept: { state: "complete", version: event.version } } };
    case "set_dismissed":
      return state.dismissed === event.dismissed ? state : { ...state, dismissed: event.dismissed };
  }
}

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

export function firstSuccessCount(state: FirstSuccessState): number {
  return Object.values(state.steps).filter(step => step.state === "complete").length;
}
