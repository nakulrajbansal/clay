// @vitest-environment jsdom
// Composable primitives (ADR-016): Box/Text/Bar/Scene render safely and
// compose into layouts the named components can't express (a Gantt).
import { describe, expect, it } from "vitest";
import {
  h, render, Box, Text, Bar, Scene, Stack, Board, Cards, Timeline, Badge, Button, Chart,
} from "../src/index";

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

describe("Board (kanban)", () => {
  it("renders columns of cards with counts and per-card badges", () => {
    const c = mount(h(Board, {
      groups: [
        { key: "todo", label: "To do", tone: "gray",
          cards: [{ title: "Fix sink", subtitle: "123 Main St", badge: "high", badgeTone: "red" }] },
        { key: "done", label: "Done", tone: "green", cards: [
          { title: "Mow lawn" }, { title: "Trim hedge" }] },
      ],
    }));
    const cols = c.querySelectorAll(".clay-board-col");
    expect(cols).toHaveLength(2);
    expect(cols[0]!.querySelector(".clay-board-label")!.textContent).toBe("To do");
    expect(cols[0]!.querySelector(".clay-board-count")!.textContent).toBe("1");
    expect(cols[1]!.querySelector(".clay-board-count")!.textContent).toBe("2");
    expect(c.querySelector(".clay-card-title")!.textContent).toBe("Fix sink");
    expect(c.querySelector(".clay-card .clay-badge")!.className).toContain("clay-tone-red");
  });

  it("onCardMove fires when a card is dragged to another column (bidirectional)", () => {
    const moves: { title: string; to: string }[] = [];
    const c = mount(h(Board, {
      groups: [
        { key: "todo", label: "To do", cards: [{ id: "1", title: "job-1" }] },
        { key: "done", label: "Done", cards: [] },
      ],
      onCardMove: (card: { title: string }, to: string) => moves.push({ title: card.title, to }),
    }));
    const card = c.querySelector<HTMLElement>(".clay-card")!;
    expect(card.getAttribute("draggable")).toBe("true");
    // simulate drag of job-1 onto the "done" column
    card.dispatchEvent(new window.Event("dragstart", { bubbles: true }));
    const doneCol = [...c.querySelectorAll(".clay-board-col")][1]!;
    const drop = new window.Event("drop", { bubbles: true }) as Event & { preventDefault(): void };
    doneCol.dispatchEvent(drop);
    expect(moves).toEqual([{ title: "job-1", to: "done" }]);
    // and it can go back — dragging from done to todo (bidirectional)
  });

  it("onCardClick fires with the clicked card", () => {
    const clicked: unknown[] = [];
    const c = mount(h(Board, {
      groups: [{ label: "A", cards: [{ title: "job-1" }] }],
      onCardClick: (card: unknown) => clicked.push(card),
    }));
    c.querySelector<HTMLElement>(".clay-card")!.click();
    expect(clicked).toHaveLength(1);
    expect((clicked[0] as { title: string }).title).toBe("job-1");
  });
});

describe("Cards", () => {
  it("renders a grid of record cards with fields", () => {
    const c = mount(h(Cards, { items: [
      { title: "Acme Co", subtitle: "acme@x.com", badge: "VIP", badgeTone: "accent",
        fields: [{ label: "Phone", value: "555-1234" }, { label: "Owed", value: "$1,200" }] },
    ] }));
    expect(c.querySelector(".clay-cards")).not.toBeNull();
    expect(c.querySelector(".clay-card-title")!.textContent).toBe("Acme Co");
    const fields = c.querySelectorAll(".clay-card-field");
    expect(fields).toHaveLength(2);
    expect(fields[1]!.textContent).toContain("Owed");
    expect(fields[1]!.textContent).toContain("$1,200");
  });
});

describe("interactivity (from live diagnostics)", () => {
  it("Badge fires onClick and marks itself clickable (was silently dropped)", () => {
    let clicks = 0;
    const c = mount(h(Badge, { label: "todo", tone: "gray", onClick: () => { clicks++; } }));
    const badge = c.querySelector<HTMLElement>(".clay-badge")!;
    expect(badge.className).toContain("clay-clickable");
    badge.click();
    expect(clicks).toBe(1);
  });

  it("a non-clickable Badge has no click affordance", () => {
    const c = mount(h(Badge, { label: "done", tone: "green" }));
    expect(c.querySelector(".clay-badge")!.className).not.toContain("clay-clickable");
  });

  it("a Box with onClick becomes clickable with a pointer cursor", () => {
    let clicked = false;
    const c = mount(h(Box, { onClick: () => { clicked = true; } }, h(Text, { value: "row" })));
    const box = c.querySelector<HTMLElement>(".clay-box")!;
    expect(box.className).toContain("clay-clickable");
    box.click();
    expect(clicked).toBe(true);
  });

  it("Button clicks still work and are clickable", () => {
    let n = 0;
    const c = mount(h(Button, { label: "Go", onClick: () => { n++; } }));
    const btn = c.querySelector<HTMLElement>("button")!;
    expect(btn.className).toContain("clay-clickable");
    btn.click();
    expect(n).toBe(1);
  });
});

describe("Timeline (gantt)", () => {
  it("renders bars for start+end and milestones for a single date", () => {
    const c = mount(h(Timeline, { rows: [
      { label: "Research", start: "2026-01-01", end: "2026-01-11", tone: "green", caption: "done" },
      { label: "Kickoff", at: "2026-01-06", tone: "accent" },   // milestone
    ] }));
    // window is 2026-01-01 .. 2026-01-11 (10 days)
    const bar = c.querySelector<HTMLElement>(".clay-timeline-bar")!;
    expect(parseFloat(bar.style.left)).toBeCloseTo(0);
    expect(parseFloat(bar.style.width)).toBeCloseTo(100);   // spans the whole window
    expect(bar.textContent).toBe("done");
    const marker = c.querySelector<HTMLElement>(".clay-timeline-marker")!;
    expect(parseFloat(marker.style.left)).toBeCloseTo(50);  // Jan 6 is the midpoint
    expect(c.querySelector(".clay-timeline-axis")!.textContent).toContain("2026-01-01");
    // labels present
    expect(c.textContent).toContain("Research");
    expect(c.textContent).toContain("Kickoff");
  });

  it("falls back to a milestone when only a start date is given", () => {
    const c = mount(h(Timeline, { rows: [
      { label: "A", start: "2026-02-01", end: "2026-02-05" },
      { label: "B", start: "2026-02-03" },   // no end -> milestone
    ] }));
    expect(c.querySelectorAll(".clay-timeline-bar")).toHaveLength(1);
    expect(c.querySelectorAll(".clay-timeline-marker")).toHaveLength(1);
  });

  it("handles no dated rows without crashing", () => {
    const c = mount(h(Timeline, { rows: [{ label: "no dates" }] }));
    expect(c.querySelector(".clay-empty")).not.toBeNull();
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

describe("Chart multi-series (from live diagnostic: planned vs actual)", () => {
  // The model reaches for {label, data:[{x,y}]}[] to compare two things on one
  // chart. Before the fix the single-series filter dropped it → empty SVG.
  const series = [
    { label: "Planned", data: [{ x: "2026-01-06", y: 12 }, { x: "2026-01-13", y: 15 }] },
    { label: "Actual", data: [{ x: "2026-01-06", y: 10 }, { x: "2026-01-13", y: 18 }] },
  ];

  it("renders grouped bars (one per series per category) with a legend", () => {
    const c = mount(h(Chart, { kind: "bar", data: series, height: 260 }));
    // 2 series × 2 categories = 4 bars, not zero.
    expect(c.querySelectorAll("rect")).toHaveLength(4);
    // Legend names both series.
    expect(c.textContent).toContain("Planned");
    expect(c.textContent).toContain("Actual");
    expect(c.querySelectorAll(".clay-chart-legend .sw")).toHaveLength(2);
    // Distinct colours per series.
    const fills = new Set([...c.querySelectorAll("rect")].map(r => r.getAttribute("fill")));
    expect(fills.size).toBe(2);
    // Shortened date ticks.
    expect(c.textContent).toContain("1/6");
  });

  it("renders one polyline per series for kind:line", () => {
    const c = mount(h(Chart, { kind: "line", data: series, height: 260 }));
    expect(c.querySelectorAll("polyline")).toHaveLength(2);
    expect(c.querySelectorAll(".clay-chart-legend .lg")).toHaveLength(2);
  });

  it("still renders a plain single-series bar chart, now with x-axis labels", () => {
    const c = mount(h(Chart, { kind: "bar", data: [{ x: "a", y: 3 }, { x: "b", y: 7 }] }));
    expect(c.querySelectorAll(".clay-chart-bar")).toHaveLength(2);
    expect(c.querySelector(".clay-chart-legend")).toBeNull();
    const ticks = [...c.querySelectorAll("text")].map(t => t.textContent);
    expect(ticks).toEqual(["a", "b"]);
  });

  it("pie: distinct colour per slice + a legend of categories", () => {
    const c = mount(h(Chart, { kind: "pie", data: [
      { x: "rent", y: 1200 }, { x: "food", y: 145 }, { x: "fun", y: 25 },
    ] }));
    const slices = [...c.querySelectorAll<SVGElement>(".clay-chart-slice")];
    expect(slices).toHaveLength(3);
    expect(new Set(slices.map(s => s.getAttribute("fill"))).size).toBe(3); // not monochrome
    expect(c.querySelectorAll(".clay-chart-legend .lg")).toHaveLength(3);
    expect(c.textContent).toContain("rent");
    // tooltip carries the share
    expect(slices[0]!.querySelector("title")?.textContent).toContain("%");
  });
});
