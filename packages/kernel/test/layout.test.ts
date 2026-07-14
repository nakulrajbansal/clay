// Direct manipulation (B4/doc 13): rearranging the layout by hand is a
// reversible commit — a normal version in the log, rewindable via the time
// slider — with no model and no migration. Touch and language share one
// history.
import { describe, expect, it } from "vitest";
import { seededStore } from "./helpers";
import type { PanelBlobInput } from "../src/index";

const panel = (id: string, region: "top" | "main" | "side", order: number): PanelBlobInput => ({
  panel_id: id, title: id, placement: { region, order },
  code: "export default function(clay){ clay.ui.render(h(EmptyState,{label:\"x\"})); }",
  declared_queries: [{ from: "projects" }], declared_writes: [],
});

describe("commitLayout (direct manipulation)", () => {
  it("moving panels is a reversible version, code untouched", async () => {
    const store = await seededStore();
    store.commit({
      intent: "panels", summary: "Adds panels.", migration: null,
      panels: [panel("a", "main", 0), panel("b", "main", 1), panel("c", "side", 0)],
    });
    const before = store.headVersion();
    const codeA = store.livePanels().find(p => p.panel_id === "a")!.code;

    // drag "b" above "a", and move "c" from side to main
    const v = store.commitLayout([
      { panel_id: "a", region: "main", order: 1 },
      { panel_id: "b", region: "main", order: 0 },
      { panel_id: "c", region: "main", order: 2 },
    ]);
    expect(v).toBe(before + 1);                       // a new version

    const live = store.livePanels();
    const at = (id: string) => live.find(p => p.panel_id === id)!.placement;
    expect(at("b")).toEqual({ region: "main", order: 0 });
    expect(at("a")).toEqual({ region: "main", order: 1 });
    expect(at("c")).toEqual({ region: "main", order: 2 });
    // code is unchanged — only placement moved
    expect(live.find(p => p.panel_id === "a")!.code).toBe(codeA);

    // reversible: rewind restores the original layout (Principle 2)
    store.rollbackTo(before);
    const back = store.livePanels();
    const b2 = (id: string) => back.find(p => p.panel_id === id)!.placement;
    expect(b2("a")).toEqual({ region: "main", order: 0 });
    expect(b2("b")).toEqual({ region: "main", order: 1 });
    expect(b2("c")).toEqual({ region: "side", order: 0 });
    store.close();
  });

  it("a no-op layout (nothing actually moved) does not create a version", async () => {
    const store = await seededStore();
    store.commit({
      intent: "panels", summary: "Adds panels.", migration: null,
      panels: [panel("a", "main", 0), panel("b", "main", 1)],
    });
    const v = store.headVersion();
    const same = store.commitLayout([
      { panel_id: "a", region: "main", order: 0 },
      { panel_id: "b", region: "main", order: 1 },
    ]);
    expect(same).toBe(v);                             // unchanged, no empty commit
    expect(store.headVersion()).toBe(v);
    store.close();
  });

  it("width is a reversible commit and survives a reorder (ADR-017)", async () => {
    const store = await seededStore();
    store.commit({
      intent: "panels", summary: "Adds panels.", migration: null,
      panels: [panel("a", "main", 0), panel("b", "main", 1)],
    });
    const before = store.headVersion();

    store.commitLayout([{ panel_id: "a", region: "main", order: 0, w: 2 }]);
    expect(store.livePanels().find(p => p.panel_id === "a")!.placement.w).toBe(2);

    // reorder without specifying w keeps a's width
    store.commitLayout([
      { panel_id: "b", region: "main", order: 0 },
      { panel_id: "a", region: "main", order: 1 },
    ]);
    expect(store.livePanels().find(p => p.panel_id === "a")!.placement.w).toBe(2);

    store.rollbackTo(before);   // rewind removes the width
    expect(store.livePanels().find(p => p.panel_id === "a")!.placement.w ?? 1).toBe(1);
    store.close();
  });

  it("a content reshape preserves a panel's width (the model omits w)", async () => {
    const store = await seededStore();
    store.commit({
      intent: "panels", summary: "Adds a wide panel.", migration: null,
      panels: [{ ...panel("a", "main", 0), placement: { region: "main", order: 0, w: 2 } }],
    });
    expect(store.livePanels().find(p => p.panel_id === "a")!.placement.w).toBe(2);
    // a model reshape re-commits the same panel with placement {region,order}
    store.commit({
      intent: "reshape", summary: "Tweaks a.", migration: null,
      panels: [panel("a", "main", 0)],   // no w — as the model would emit
    });
    expect(store.livePanels().find(p => p.panel_id === "a")!.placement.w).toBe(2);   // kept
    store.close();
  });

  it("appears in history as a hand-rearrange", async () => {
    const store = await seededStore();
    store.commit({
      intent: "panels", summary: "Adds panels.", migration: null,
      panels: [panel("a", "main", 0), panel("b", "main", 1)],
    });
    store.commitLayout([{ panel_id: "a", region: "side", order: 0 }]);
    const last = store.history().at(-1)!;
    expect(last.intent_text).toBe("rearrange layout");
    expect(last.summary).toContain("Rearranged");
    store.close();
  });
});
