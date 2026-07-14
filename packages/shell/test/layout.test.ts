// Pure reorder math for direct manipulation (B4).
import { describe, expect, it } from "vitest";
import { reorder, type Region } from "../src/app/layout";

const p = (id: string, region: Region, order: number) =>
  ({ panel_id: id, placement: { region, order } });

describe("reorder", () => {
  it("moves a panel up within a region and reindexes", () => {
    const panels = [p("a", "main", 0), p("b", "main", 1), p("c", "main", 2)];
    const out = reorder(panels, "c", "main", 0);   // drop c at the top
    expect(out.filter(x => x.region === "main").sort((m, n) => m.order - n.order)
      .map(x => x.panel_id)).toEqual(["c", "a", "b"]);
  });

  it("moves a panel across regions", () => {
    const panels = [p("a", "main", 0), p("b", "main", 1), p("c", "side", 0)];
    const out = reorder(panels, "a", "side", 1);   // a joins side after c
    const side = out.filter(x => x.region === "side").sort((m, n) => m.order - n.order);
    expect(side.map(x => x.panel_id)).toEqual(["c", "a"]);
    // main reindexes to just b at 0
    expect(out.find(x => x.panel_id === "b")).toEqual({ panel_id: "b", region: "main", order: 0 });
  });

  it("clamps an out-of-range index", () => {
    const panels = [p("a", "top", 0), p("b", "top", 1)];
    const out = reorder(panels, "a", "top", 99);
    expect(out.filter(x => x.region === "top").sort((m, n) => m.order - n.order)
      .map(x => x.panel_id)).toEqual(["b", "a"]);
  });

  it("dropping in place is a no-op ordering", () => {
    const panels = [p("a", "main", 0), p("b", "main", 1)];
    const out = reorder(panels, "a", "main", 0);
    expect(out).toContainEqual({ panel_id: "a", region: "main", order: 0 });
    expect(out).toContainEqual({ panel_id: "b", region: "main", order: 1 });
  });
});
