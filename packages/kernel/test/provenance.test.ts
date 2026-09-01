import { describe, expect, it } from "vitest";
import { ClayStore, type PanelBlobInput } from "../src/index";

const panel = (title: string): PanelBlobInput => ({
  panel_id: "overview",
  title,
  placement: { region: "main", order: 0 },
  code: "export default function () {}",
  declared_queries: [],
  declared_writes: [],
});

describe("panel provenance", () => {
  it("derives creation and latest-shape versions from existing history", async () => {
    const store = await ClayStore.openMemory();
    try {
      store.commit({
        intent: "build an overview",
        summary: "Created the overview.",
        migration: null,
        panels: [panel("Overview")],
      });
      store.commitLayout([{ panel_id: "overview", region: "top", order: 0 }]);
      store.renamePanel("overview", "Portfolio overview");

      expect(store.panelProvenance("overview")).toMatchObject({
        panel_id: "overview",
        createdVersion: 1,
        lastChangedVersion: 3,
        createdIntent: "build an overview",
        lastChangedIntent: "rename the Overview panel",
        createdSummary: "Created the overview.",
        lastChangedSummary: "Renamed “Overview” to “Portfolio overview”.",
      });
      expect(store.panelProvenance("missing")).toBeNull();
    } finally { store.close(); }
  });

  it("starts a new provenance incarnation after removal and re-add", async () => {
    const store = await ClayStore.openMemory();
    try {
      store.commit({ intent: "first", summary: "First panel.", migration: null,
        panels: [panel("First")] });
      store.removePanel("overview");
      store.commit({ intent: "bring it back", summary: "Re-added panel.", migration: null,
        panels: [panel("Second")] });

      expect(store.panelProvenance("overview")).toMatchObject({
        createdVersion: 3,
        lastChangedVersion: 3,
        createdIntent: "bring it back",
      });
    } finally { store.close(); }
  });
});
