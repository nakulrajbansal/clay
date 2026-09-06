import { describe, expect, it } from "vitest";
import {
  FIRST_SUCCESS_SETTING_KEY,
  FIRST_WRITE_STORAGE_COPY,
  TEMPORARY_FIRST_WRITE_COPY,
  applyFirstSuccessEvent,
  emptyFirstSuccessState,
  loadFirstSuccessState,
  mutateFirstSuccessState,
  reconcileFirstSuccessAfterImportUndo,
  type FirstSuccessState,
  type FirstSuccessSettingClient,
} from "../src/app/first-success-state";

function completed(state: FirstSuccessState): string[] {
  return Object.entries(state.steps)
    .filter(([, evidence]) => evidence.state === "complete")
    .map(([step]) => step);
}

describe("first-success evidence", () => {
  it("records the four durable steps without treating samples or no-ops as activation", () => {
    let state = emptyFirstSuccessState();
    state = applyFirstSuccessEvent(state, {
      type: "app_created", path: "recommended", shellId: "tracker",
    });
    expect(completed(state)).toEqual(["app"]);

    const afterSample = applyFirstSuccessEvent(state, {
      type: "real_record", source: "create", changed: 1, sample: true,
    });
    const afterNoop = applyFirstSuccessEvent(state, {
      type: "real_record", source: "create", changed: 0, sample: false,
    });
    expect(afterSample).toBe(state);
    expect(afterNoop).toBe(state);

    state = applyFirstSuccessEvent(state, {
      type: "real_record", source: "import", changed: 3, sample: false,
    });
    expect(completed(state)).toEqual(["app", "realRecord"]);
    expect(applyFirstSuccessEvent(state, {
      type: "work_used", workspaceMode: "customize", realRecordAvailable: true,
    })).toBe(state);
    expect(applyFirstSuccessEvent(state, {
      type: "work_used", workspaceMode: "work", realRecordAvailable: false,
    })).toBe(state);

    state = applyFirstSuccessEvent(state, {
      type: "work_used", workspaceMode: "work", realRecordAvailable: true,
    });
    expect(completed(state)).toEqual(["app", "realRecord", "work"]);
    expect(applyFirstSuccessEvent(state, {
      type: "customization_kept", version: 2, changed: false,
    })).toBe(state);
    state = applyFirstSuccessEvent(state, {
      type: "customization_kept", version: 2, changed: true,
    });
    expect(completed(state)).toEqual(["app", "realRecord", "work", "customization"]);
  });

  it("uses exact truthful first-write storage copy without protected or backup claims", () => {
    expect(FIRST_WRITE_STORAGE_COPY).toBe(
      "Records are stored in this browser on this device. Clearing this browser’s site data can remove them.",
    );
    expect(TEMPORARY_FIRST_WRITE_COPY).toBe(
      "This is a temporary session. Records can disappear when this tab closes.",
    );
    expect(FIRST_WRITE_STORAGE_COPY).not.toMatch(/protected|backed up|backup/i);
    expect(TEMPORARY_FIRST_WRITE_COPY).not.toMatch(/protected|backed up|backup/i);
  });

  it("regresses only record-dependent milestones when Undo leaves no real record", () => {
    const completedState: FirstSuccessState = {
      version: 1, revision: 4, dismissed: true,
      steps: {
        app: { state: "complete", path: "import", shellId: "blank" },
        realRecord: { state: "complete", source: "import" },
        work: { state: "complete" },
        customization: { state: "complete", version: 2 },
      },
    };
    expect(reconcileFirstSuccessAfterImportUndo(completedState, true)).toBe(completedState);
    expect(reconcileFirstSuccessAfterImportUndo(completedState, false)).toEqual({
      ...completedState,
      revision: 5,
      steps: {
        ...completedState.steps,
        realRecord: { state: "pending" },
        work: { state: "pending" },
      },
    });
  });
});

describe("first-success app-setting CAS", () => {
  it("merges the requested event onto conflicting durable state and preserves dismissal", async () => {
    let stored = emptyFirstSuccessState();
    let first = true;
    const expectedRevisions: number[] = [];
    const client: FirstSuccessSettingClient = {
      getSetting: async key => {
        expect(key).toBe(FIRST_SUCCESS_SETTING_KEY);
        return null;
      },
      compareAndSetSetting: async (key, expectedRevision, value) => {
        expect(key).toBe(FIRST_SUCCESS_SETTING_KEY);
        expectedRevisions.push(expectedRevision);
        if (first) {
          first = false;
          stored = { ...stored, revision: 1, dismissed: true };
          return { ok: false, current: stored };
        }
        stored = value as FirstSuccessState;
        return { ok: true, current: stored };
      },
    };

    const result = await mutateFirstSuccessState(client, {
      type: "app_created", path: "recommended", shellId: "tracker",
    });
    expect(expectedRevisions).toEqual([0, 1]);
    expect(result.revision).toBe(2);
    expect(result.dismissed).toBe(true);
    expect(result.steps.app).toMatchObject({ state: "complete", path: "recommended" });
  });

  it("keeps each worker-backed app setting isolated and resumes a dismissed checklist", async () => {
    const makeClient = (): FirstSuccessSettingClient & { value: FirstSuccessState | null } => {
      const client = {
        value: null as FirstSuccessState | null,
        getSetting: async () => client.value,
        compareAndSetSetting: async (_key: string, expected: number, value: unknown) => {
          const revision = client.value?.revision ?? 0;
          if (revision !== expected) return { ok: false, current: client.value };
          client.value = value as FirstSuccessState;
          return { ok: true, current: client.value };
        },
      };
      return client;
    };
    const appA = makeClient();
    const appB = makeClient();
    await mutateFirstSuccessState(appA, {
      type: "app_created", path: "blank", shellId: "blank",
    });
    await mutateFirstSuccessState(appA, { type: "set_dismissed", dismissed: true });
    expect((await loadFirstSuccessState(appA)).dismissed).toBe(true);
    expect((await loadFirstSuccessState(appB))).toEqual(emptyFirstSuccessState());
    const resumed = await mutateFirstSuccessState(appA, {
      type: "set_dismissed", dismissed: false,
    });
    expect(resumed.dismissed).toBe(false);
    expect(resumed.steps.app.state).toBe("complete");
  });

  it("fails closed after bounded repeated conflicts", async () => {
    const client: FirstSuccessSettingClient = {
      getSetting: async () => null,
      compareAndSetSetting: async () => ({ ok: false, current: emptyFirstSuccessState() }),
    };
    await expect(mutateFirstSuccessState(client, {
      type: "app_created", path: "recommended", shellId: "tracker",
    }, 2)).rejects.toThrow(/changed in another view/i);
  });

  it("fails closed on unknown durable state, step, or evidence keys", async () => {
    const load = async (value: unknown): Promise<FirstSuccessState> => loadFirstSuccessState({
      getSetting: async () => value,
      compareAndSetSetting: async () => ({ ok: false, current: value }),
    });
    const clean = emptyFirstSuccessState();
    await expect(load({ ...clean, unexpected: true })).rejects.toThrow(/invalid/i);
    await expect(load({
      ...clean, steps: { ...clean.steps, unexpected: { state: "complete" } },
    })).rejects.toThrow(/invalid/i);
    await expect(load({
      ...clean,
      steps: { ...clean.steps, app: {
        state: "complete", path: "recommended", shellId: "tracker", unexpected: true,
      } },
    })).rejects.toThrow(/invalid/i);
  });
});
