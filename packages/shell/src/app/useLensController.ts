import { useEffect, useMemo, useRef, useState } from "react";
import type { LivePanel, PanelProvenance } from "@clay/kernel";
import type { WorkerClient } from "./worker-client";
import {
  addSavedLens, applyLens, applySavedLensLayout, buildSituationalLenses,
  captureSavedLens, deleteSavedLens, emptySavedLensLibrary, isSavedLensId,
  loadLensId, saveLensId, SAVED_LENS_SETTING_KEY,
  validateSavedLensLibrary,
  type LensId, type SavedLensLibraryV1,
} from "./lenses";

type Notify = (message: string, kind: string, action?: {
  label: string; run: () => void;
}) => void;

export function useLensController(input: {
  ready: boolean;
  appId: string;
  client: WorkerClient | null;
  panels: LivePanel[];
  provenance: PanelProvenance[];
  head: number;
  notify: Notify;
  onLensChanged?: (id: LensId) => void;
}) {
  const [lensId, setLensId] = useState<LensId>(() => {
    if (typeof localStorage === "undefined") return "all";
    return loadLensId(localStorage, input.appId);
  });
  const [library, setLibrary] = useState<SavedLensLibraryV1>(() => emptySavedLensLibrary());
  const [libraryLoaded, setLibraryLoaded] = useState(false);
  const mutationQueue = useRef<Promise<void>>(Promise.resolve());
  const currentAppId = useRef(input.appId);
  currentAppId.current = input.appId;

  useEffect(() => {
    if (!input.ready || !input.client) return;
    let current = true;
    setLibraryLoaded(false);
    void input.client.getSetting<unknown>(SAVED_LENS_SETTING_KEY)
      .then(value => {
        if (!current) return;
        const parsed = validateSavedLensLibrary(value);
        if (parsed.status === "invalid") throw new Error("The saved-lens library is invalid.");
        setLibrary(parsed.library);
        setLibraryLoaded(true);
      })
      .catch(() => {
        if (!current) return;
        setLibraryLoaded(false);
        input.notify("Saved lenses could not be loaded. Changes are disabled to protect existing lenses.",
          "danger");
      });
    return (): void => { current = false; };
  }, [input.appId, input.client, input.ready]);

  const lenses = useMemo(() => buildSituationalLenses(input.panels, library.lenses)
    .map(lens => {
      if (!isSavedLensId(lens.id) || !lens.saved) return lens;
      const available = applySavedLensLayout(input.panels, lens.saved, input.provenance);
      const staleCount = lens.saved.panels.length - available.length;
      return {
        ...lens,
        panelIds: available.map(panel => panel.panel_id),
        capturedCount: lens.saved.panels.length,
        staleCount,
        description: staleCount > 0
          ? `${available.length} available · ${staleCount} no longer match`
          : "Saved view and layout",
      };
    }), [input.panels, input.provenance, library.lenses]);
  const activeLens = lenses.find(lens => lens.id === lensId);
  const lensPanels = useMemo(() => {
    if (!libraryLoaded && isSavedLensId(lensId)) return input.panels;
    const saved = isSavedLensId(lensId)
      ? library.lenses.find(lens => lens.id === lensId) : undefined;
    if (isSavedLensId(lensId) && !saved) return [];
    return saved
      ? applySavedLensLayout(input.panels, saved, input.provenance)
      : applyLens(input.panels, lensId, library.lenses);
  }, [input.panels, input.provenance, lensId, library.lenses, libraryLoaded]);

  const mutateLibrary = <T,>(build: (current: SavedLensLibraryV1) => {
    next: SavedLensLibraryV1; result: T;
  }): Promise<T> => {
    if (!input.client || !libraryLoaded)
      return Promise.reject(new Error("Saved lenses are still loading. Try again in a moment."));
    const appId = input.appId;
    const run = async (): Promise<T> => {
      let current: SavedLensLibraryV1;
      const loaded = validateSavedLensLibrary(
        await input.client!.getSetting<unknown>(SAVED_LENS_SETTING_KEY),
      );
      if (loaded.status === "invalid") throw new Error("The saved-lens library is invalid.");
      current = loaded.library;
      for (let attempt = 0; attempt < 3; attempt++) {
        const built = build(current);
        const written = await input.client!.compareAndSetSetting(
          SAVED_LENS_SETTING_KEY, current.revision, built.next,
        );
        if (written.ok) {
          if (currentAppId.current === appId) setLibrary(built.next);
          return built.result;
        }
        const latest = validateSavedLensLibrary(written.current);
        if (latest.status === "invalid") throw new Error("The saved-lens library changed unexpectedly.");
        current = latest.library;
      }
      throw new Error("Saved lenses changed on another operation. Try again.");
    };
    const operation = mutationQueue.current.then(run, run);
    mutationQueue.current = operation.then(() => undefined, () => undefined);
    return operation;
  };

  const resetLens = (): void => {
    setLensId("all"); input.onLensChanged?.("all");
    if (typeof localStorage !== "undefined") saveLensId(localStorage, input.appId, "all");
  };

  const selectLens = (id: LensId): void => {
    const lens = lenses.find(item => item.id === id);
    if (!lens || (id !== "all" && lens.panelIds.length === 0)) return;
    setLensId(id); input.onLensChanged?.(id);
    if (typeof localStorage !== "undefined") saveLensId(localStorage, input.appId, id);
    input.notify(`${lens.name}: ${lens.panelIds.length} of ${input.panels.length} views. Your records are unchanged.`,
      "default", id === "all" ? undefined : { label: "Show all", run: () => selectLens("all") });
  };

  const saveCurrentLens = async (name: string): Promise<void> => {
    try {
      const saved = captureSavedLens({ name, panels: lensPanels,
        provenance: input.provenance, version: input.head });
      await mutateLibrary(current => ({ next: addSavedLens(current, saved), result: saved }));
      setLensId(saved.id);
      input.onLensChanged?.(saved.id);
      if (typeof localStorage !== "undefined") saveLensId(localStorage, input.appId, saved.id);
      input.notify(`Saved lens “${saved.name}”`, "success");
    } catch (error) {
      input.notify(error instanceof Error ? error.message : String(error), "danger");
    }
  };

  const removeSavedLens = async (id: LensId): Promise<void> => {
    if (!isSavedLensId(id)) return;
    try {
      const result = await mutateLibrary(current => {
        const deleted = deleteSavedLens(current, id);
        return { next: deleted.library, result: deleted };
      });
      if (lensId === id) selectLens("all");
      input.notify(`Deleted lens “${result.deleted.name}”`, "default");
    } catch (error) {
      input.notify(error instanceof Error ? error.message : String(error), "danger");
    }
  };

  useEffect(() => {
    if (!input.ready || !libraryLoaded || input.panels.length === 0 || lensId === "all") return;
    if (activeLens && activeLens.panelIds.length > 0) return;
    resetLens();
    input.notify("That saved lens no longer matches the current panel versions. Showing all views.",
      "default");
  }, [activeLens, input.panels.length, input.ready, lensId, libraryLoaded]);

  return { lensId, lenses, lensPanels, lensReady: libraryLoaded, selectLens, resetLens,
    saveCurrentLens, removeSavedLens };
}
