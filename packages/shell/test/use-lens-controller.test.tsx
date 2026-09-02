// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LivePanel, PanelProvenance } from "@clay/kernel";
import { SAVED_LENS_SETTING_KEY, type SavedLensLibraryV1 } from "../src/app/lenses";
import { useLensController } from "../src/app/useLensController";
import type { WorkerClient } from "../src/app/worker-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const panel: LivePanel = {
  panel_id: "work", title: "Work", version: 2,
  placement: { region: "main", order: 0 }, code: "export default function(clay){}",
  declared_queries: [], declared_writes: [],
};
const provenance: PanelProvenance = {
  panel_id: "work", createdVersion: 1, lastChangedVersion: 2,
  createdAt: "2026-09-02T00:00:00.000Z", lastChangedAt: "2026-09-02T00:00:00.000Z",
  createdIntent: "new incarnation", lastChangedIntent: "new incarnation",
  createdSummary: "new incarnation", lastChangedSummary: "new incarnation",
};
const savedId = "saved:550e8400-e29b-41d4-a716-446655440000" as const;
const library: SavedLensLibraryV1 = {
  format: 1, revision: 1, lenses: [{
    id: savedId, name: "Old work", createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z", capturedAtVersion: 1,
    panels: [{ panelId: "work", createdVersion: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      placement: { region: "main", order: 0 }, filters: {} }],
  }],
};

afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("useLensController stale reconciliation", () => {
  it("resets an exhausted saved lens to All views after canonical storage loads", async () => {
    localStorage.setItem("clay_lens_app", savedId);
    const notices: string[] = [];
    const latest: { current: ReturnType<typeof useLensController> | null } = { current: null };
    const client = {
      getSetting: async (key: string) => key === SAVED_LENS_SETTING_KEY ? library : null,
      setSetting: async () => null,
    } as unknown as WorkerClient;
    function Probe(): null {
      latest.current = useLensController({
        ready: true, appId: "app", client, panels: [panel], provenance: [provenance], head: 2,
        notify: message => notices.push(message),
      });
      return null;
    }
    const mount = document.createElement("div");
    document.body.append(mount);
    await act(async () => { createRoot(mount).render(<Probe />); });
    await vi.waitFor(() => expect(latest.current?.lensId).toBe("all"));
    expect(latest.current?.lensPanels.map(item => item.panel_id)).toEqual(["work"]);
    expect(notices.some(message => /no longer matches/.test(message))).toBe(true);
  });

  it("never writes while the canonical library load is pending", async () => {
    let resolveLoad!: (value: unknown) => void;
    const load = new Promise<unknown>(resolve => { resolveLoad = resolve; });
    const compare = vi.fn();
    const notices: string[] = [];
    const latest: { current: ReturnType<typeof useLensController> | null } = { current: null };
    const client = {
      getSetting: () => load,
      compareAndSetSetting: compare,
    } as unknown as WorkerClient;
    function Probe(): null {
      latest.current = useLensController({
        ready: true, appId: "app", client, panels: [panel], provenance: [provenance], head: 2,
        notify: message => notices.push(message),
      });
      return null;
    }
    const mount = document.createElement("div");
    document.body.append(mount);
    await act(async () => { createRoot(mount).render(<Probe />); });
    await act(async () => { await latest.current!.saveCurrentLens("New lens"); });
    expect(compare).not.toHaveBeenCalled();
    expect(notices.some(message => /still loading/i.test(message))).toBe(true);
    await act(async () => { resolveLoad(library); await load; });
  });

  it("merges a save into the latest revision through compare-and-set", async () => {
    let stored: SavedLensLibraryV1 = library;
    const client = {
      getSetting: async () => stored,
      compareAndSetSetting: async (_key: string, expectedRevision: number, value: unknown) => {
        if (expectedRevision !== stored.revision) return { ok: false, current: stored };
        stored = value as SavedLensLibraryV1;
        return { ok: true, current: stored };
      },
    } as unknown as WorkerClient;
    const latest: { current: ReturnType<typeof useLensController> | null } = { current: null };
    function Probe(): null {
      latest.current = useLensController({
        ready: true, appId: "app", client, panels: [panel], provenance: [provenance], head: 2,
        notify: () => undefined,
      });
      return null;
    }
    const mount = document.createElement("div");
    document.body.append(mount);
    await act(async () => { createRoot(mount).render(<Probe />); });
    await vi.waitFor(() => expect(latest.current?.lensReady).toBe(true));
    await act(async () => { await latest.current!.saveCurrentLens("New lens"); });
    expect(stored.revision).toBe(2);
    expect(stored.lenses.map(item => item.name)).toEqual(["Old work", "New lens"]);
  });
});
