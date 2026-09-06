import type { StarterShellId } from "../shells/seed";
import type { WorkspaceMode } from "./workspace-mode";

export const FIRST_SUCCESS_SETTING_KEY = "release_a_first_success_v1";
export const FIRST_WRITE_STORAGE_COPY =
  "Records are stored in this browser on this device. Clearing this browser’s site data can remove them.";
export const TEMPORARY_FIRST_WRITE_COPY =
  "This is a temporary session. Records can disappear when this tab closes.";

type PendingEvidence = { state: "pending" };
type AppEvidence = PendingEvidence | {
  state: "complete";
  path: "recommended" | "import" | "gallery" | "blank";
  shellId: StarterShellId;
};
type RecordEvidence = PendingEvidence | {
  state: "complete";
  source: "create" | "import";
};
type WorkEvidence = PendingEvidence | { state: "complete" };
type CustomizationEvidence = PendingEvidence | {
  state: "complete";
  version: number;
};

export type FirstSuccessState = {
  version: 1;
  revision: number;
  dismissed: boolean;
  steps: {
    app: AppEvidence;
    realRecord: RecordEvidence;
    work: WorkEvidence;
    customization: CustomizationEvidence;
  };
};

export type FirstSuccessEvent =
  | { type: "app_created"; path: "recommended" | "import" | "gallery" | "blank";
      shellId: StarterShellId }
  | { type: "real_record"; source: "create" | "import"; changed: number; sample: boolean }
  | { type: "work_used"; workspaceMode: WorkspaceMode; realRecordAvailable: boolean }
  | { type: "customization_kept"; version: number; changed: boolean }
  | { type: "set_dismissed"; dismissed: boolean };

export type FirstSuccessSettingClient = {
  getSetting: (key: string) => Promise<unknown>;
  compareAndSetSetting: (
    key: string, expectedRevision: number, value: FirstSuccessState,
  ) => Promise<{ ok: boolean; current: unknown }>;
};

export function emptyFirstSuccessState(): FirstSuccessState {
  return {
    version: 1,
    revision: 0,
    dismissed: false,
    steps: {
      app: { state: "pending" },
      realRecord: { state: "pending" },
      work: { state: "pending" },
      customization: { state: "pending" },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function pending(value: unknown): value is PendingEvidence {
  return isRecord(value) && value.state === "pending" && Object.keys(value).length === 1;
}

export function parseFirstSuccessState(value: unknown): FirstSuccessState {
  if (!isRecord(value) || value.version !== 1
      || !hasExactKeys(value, ["dismissed", "revision", "steps", "version"])
      || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
      || typeof value.dismissed !== "boolean" || !isRecord(value.steps))
    throw new Error("First-success progress is invalid");
  const steps = value.steps;
  if (!isRecord(steps.app) || !isRecord(steps.realRecord)
      || !isRecord(steps.work) || !isRecord(steps.customization)
      || !hasExactKeys(steps, ["app", "customization", "realRecord", "work"]))
    throw new Error("First-success progress is invalid");

  const app = steps.app;
  const validApp = pending(app) || (app.state === "complete"
    && hasExactKeys(app, ["path", "shellId", "state"])
    && ["recommended", "import", "gallery", "blank"].includes(String(app.path))
    && typeof app.shellId === "string" && app.shellId.length > 0 && app.shellId.length <= 40);
  const realRecord = steps.realRecord;
  const validRecord = pending(realRecord) || (realRecord.state === "complete"
    && hasExactKeys(realRecord, ["source", "state"])
    && (realRecord.source === "create" || realRecord.source === "import"));
  const work = steps.work;
  const validWork = pending(work) || (work.state === "complete"
    && hasExactKeys(work, ["state"]));
  const customization = steps.customization;
  const validCustomization = pending(customization) || (customization.state === "complete"
    && hasExactKeys(customization, ["state", "version"])
    && Number.isSafeInteger(customization.version) && Number(customization.version) > 0);
  if (!validApp || !validRecord || !validWork || !validCustomization)
    throw new Error("First-success progress is invalid");

  return value as FirstSuccessState;
}

/** Undo may remove the only canonical real-record evidence. Reconcile the
 * dependent milestones in the same worker transaction while preserving app,
 * customization, dismissal, and any surviving real-record evidence. */
export function reconcileFirstSuccessAfterImportUndo(
  value: unknown,
  realRecordAvailable: boolean,
): FirstSuccessState {
  const state = parseFirstSuccessState(value);
  if (realRecordAvailable
      || (state.steps.realRecord.state === "pending" && state.steps.work.state === "pending"))
    return state;
  if (state.revision >= Number.MAX_SAFE_INTEGER)
    throw new Error("First-success progress revision cannot advance");
  return {
    ...state,
    revision: state.revision + 1,
    steps: {
      ...state.steps,
      realRecord: { state: "pending" },
      work: { state: "pending" },
    },
  };
}

export function applyFirstSuccessEvent(
  state: FirstSuccessState,
  event: FirstSuccessEvent,
): FirstSuccessState {
  switch (event.type) {
    case "app_created":
      if (state.steps.app.state === "complete") return state;
      return { ...state, steps: { ...state.steps,
        app: { state: "complete", path: event.path, shellId: event.shellId } } };
    case "real_record":
      if (state.steps.realRecord.state === "complete"
          || event.sample || !Number.isSafeInteger(event.changed) || event.changed <= 0) return state;
      return { ...state, steps: { ...state.steps,
        realRecord: { state: "complete", source: event.source } } };
    case "work_used":
      if (state.steps.work.state === "complete" || event.workspaceMode !== "work"
          || !event.realRecordAvailable || state.steps.realRecord.state !== "complete") return state;
      return { ...state, steps: { ...state.steps, work: { state: "complete" } } };
    case "customization_kept":
      if (state.steps.customization.state === "complete" || !event.changed
          || !Number.isSafeInteger(event.version) || event.version <= 0) return state;
      return { ...state, steps: { ...state.steps,
        customization: { state: "complete", version: event.version } } };
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
  event: FirstSuccessEvent,
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
