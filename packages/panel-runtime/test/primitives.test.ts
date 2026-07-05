// @vitest-environment jsdom
// Composable primitives (ADR-016): Box/Text/Bar/Scene render safely and
// compose into layouts the named components can't express (a Gantt).
import { describe, expect, it } from "vitest";
import { h, render, Box, Text, Bar, Scene, Stack } from "../src/index";

function mount(vnode: Parameters<typeof render>[0]): HTMLElement {
  const c = document.createElement("div");
  render(vnode, c);
  return c;
}

describe("Box", () => {
  it("maps enumerated tokens to classes; ignores unknown values", () => {
    const c = mount(h(Box, { direction: "row", gap: "lg", pad: "sm",
      align: "center", justify: "between", wrap: true, grow: true, tone: "accent" },
      h(Text, { value: "hi" })));
    const box = c.querySelector(".clay-box")!;
    expect(box.className).toContain("clay-box-row");
    expect(box.className).toContain("clay-gap-lg");
    expect(box.className).toContain("clay-pad-sm");
    expect(box.className).toContain("clay-align-center");
    expect(box.className).toContain("clay-justify-between");
    expect(box.className).toContain("clay-box-wrap");
    expect(box.className).toContain("clay-tone-accent");
    expect(box.textContent).toBe("hi");
  });

  it("rejects a garbage token rather than injecting it", () => {
    const c = mount(h(Box, { gap: "'; DROP TABLE --", tone: "evil" }));
    const box = c.querySelector(".clay-box")!;
    expect(box.className).not.toContain("DROP");
    expect(box.className).not.toContain("evil");
  });
});

describe("Text", () => {
  it("renders value with size/weight/tone classes", () => {
    const c = mount(h(Text, { value: "Total", size: "xl", weight: "bold", tone: "green" }));
    const t = c.querySelector(".clay-text")!;
    expect(t.textContent).toBe("Total");
    expect(t.className).toContain("clay-text-xl");
    expect(t.className).toContain("clay-text-bold");
    expect(t.className).toContain("clay-tone-fg-green");
  });
});

describe("Bar", () => {
  it("positions a proportional fill by offset + value (gantt row)", () => {
    const c = mount(h(Bar, { label: "Design", offset: 0.25, value: 0.5, tone: "amber", caption: "Mar–Apr" }));
    const fill = c.querySelector<HTMLElement>(".clay-bar-fill")!;
    // jsdom normalizes "25.00%" -> "25%"; parse to compare the value
    expect(parseFloat(fill.style.marginLeft)).toBeCloseTo(25);
    expect(parseFloat(fill.style.width)).toBeCloseTo(50);
    expect(fill.className).toContain("clay-tone-amber");
    expect(c.querySelector(".clay-bar-label")!.textContent).toBe("Design");
    expect(c.querySelector(".clay-bar-caption")!.textContent).toBe("Mar–Apr");
  });

  it("clamps out-of-range and never overflows the row", () => {
    const c = mount(h(Bar, { offset: 0.8, value: 5 }));   // value would overflow
    const fill = c.querySelector<HTMLElement>(".clay-bar-fill")!;
    expect(parseFloat(fill.style.marginLeft)).toBeCloseTo(80);
    expect(parseFloat(fill.style.width)).toBeCloseTo(20);   // capped to 1 - offset
  });
});

describe("Scene", () => {
  it("draws numeric shapes with token fills and textContent labels", () => {
    const c = mount(h(Scene, {
      width: 300, height: 100,
      shapes: [
        { kind: "rect", x: 10, y: 10, w: 80, h: 20, tone: "green", label: "Phase 1" },
        { kind: "line", x1: 0, y1: 50, x2: 300, y2: 50, tone: "gray" },
        { kind: "circle", cx: 150, cy: 60, r: 8, tone: "red" },
        { kind: "text", x: 12, y: 80, text: "milestone" },
      ],
    }));
    const svg = c.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 300 100");
    expect(svg.querySelectorAll("rect")).toHaveLength(1);
    expect(svg.querySelector("rect")!.getAttribute("class")).toContain("clay-fill-green");
    expect(svg.querySelector("rect title")!.textContent).toBe("Phase 1");
    expect(svg.querySelectorAll("line")).toHaveLength(1);
    expect(svg.querySelectorAll("circle")).toHaveLength(1);
    expect(svg.querySelector("text")!.textContent).toBe("milestone");
  });

  it("ignores unknown shape kinds and caps shape count", () => {
    const shapes = [{ kind: "iframe", src: "evil" }, { kind: "script" },
      ...Array.from({ length: 3000 }, () => ({ kind: "rect", x: 0, y: 0, w: 1, h: 1 }))];
    const c = mount(h(Scene, { width: 100, height: 100, shapes }));
    expect(c.querySelectorAll("iframe, script")).toHaveLength(0);
    expect(c.querySelectorAll("rect").length).toBeLessThanOrEqual(2000);
  });
});

describe("composition: a Gantt the named components can't express", () => {
  it("renders a labelled timeline from Box + Text + Bar", () => {
    const tasks = [
      { name: "Research", start: 0, end: 0.3 },
      { name: "Design", start: 0.25, end: 0.6 },
      { name: "Build", start: 0.55, end: 1 },
    ];
    const c = mount(h(Box, { direction: "col", gap: "sm" },
      ...tasks.map(t => h(Box, { direction: "row", gap: "md", align: "center" },
        h(Text, { value: t.name, size: "sm" }),
        h(Bar, { offset: t.start, value: t.end - t.start, tone: "accent" })))));
    expect(c.querySelectorAll(".clay-bar")).toHaveLength(3);
    expect(c.textContent).toContain("Research");
    const fills = [...c.querySelectorAll<HTMLElement>(".clay-bar-fill")];
    expect(parseFloat(fills[1]!.style.marginLeft)).toBeCloseTo(25);   // Design starts at 0.25
    // Stack still works too (regression)
    expect(() => mount(h(Stack, {}, h(Text, { value: "x" })))).not.toThrow();
  });
});
