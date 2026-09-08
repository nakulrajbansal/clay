import { describe, expect, it } from "vitest";

import {
  buildCssSymbolPlan,
  transformCss,
  transformStyleSource,
} from "../config/css-optimizer.mjs";

const cssSources = [
  {
    id: "ui.css",
    code: `
      :root { --accent: #c44; --accent-color: #c44; }
      .alpha-card { color: var(--accent-color); background: var(--accent); animation: fade-in .2s; }
      .alpha-card.selected-state { border-color: var(--accent-color); }
      .runtime-success { color: var(--accent-color); }
      @keyframes fade-in { from { opacity: 0; } }
      .asset { background-image: url("./icon.svg"); }
      @media (max-width: 600px) { .alpha-card { display: block; } }
    `,
  },
];
const codeSources = [
  {
    id: "View.tsx",
    code: [
      'const label = "alpha-card";',
      'const property = "--accent-color";',
      'const publicProperty = "--accent";',
      'const shellProperty = "--shell-accent";',
      'export function View({ selected }: { selected: boolean }) {',
      '  const found = document.querySelector(".alpha-card");',
      '  return <div className={`alpha-card${selected ? " selected-state" : ""}`}',
      '    data-label={label} data-found={Boolean(found)} style={{ color: `var(${property})` }} />;',
      '}',
    ].join("\n"),
  },
];

describe("production CSS symbol compaction", () => {
  it("builds a deterministic plan from static style-bearing class uses", () => {
    const first = buildCssSymbolPlan({ cssSources, codeSources });
    const second = buildCssSymbolPlan({
      cssSources: [...cssSources].reverse(), codeSources: [...codeSources].reverse(),
    });

    expect([...first.classes]).toEqual([...second.classes]);
    expect([...first.customProperties]).toEqual([...second.customProperties]);
    expect([...first.codeCustomProperties]).toEqual([...second.codeCustomProperties]);
    expect(first.classes.has("alpha-card")).toBe(true);
    expect(first.classes.has("selected-state")).toBe(true);
    expect(first.classes.has("runtime-success")).toBe(false);
    expect(first.customProperties.has("--accent-color")).toBe(true);
    expect(first.customProperties.has("--accent")).toBe(true);
    expect(first.codeCustomProperties.has("--accent")).toBe(false);
    expect(first.codeCustomProperties.get("--shell-accent"))
      .toBe(first.customProperties.get("--accent"));
    expect(first.keyframes.has("fade-in")).toBe(true);
  });

  it("rewrites only style-bearing class literals while syncing CSS identifiers", () => {
    const plan = buildCssSymbolPlan({ cssSources, codeSources });
    const alpha = plan.classes.get("alpha-card");
    const selected = plan.classes.get("selected-state");
    const accent = plan.customProperties.get("--accent-color");
    const publicAccent = plan.customProperties.get("--accent");
    const fade = plan.keyframes.get("fade-in");
    expect(alpha).toBeTruthy();
    expect(selected).toBeTruthy();
    expect(accent).toBeTruthy();
    expect(publicAccent).toBeTruthy();
    expect(plan.codeCustomProperties.has("--accent")).toBe(false);
    expect(plan.codeCustomProperties.get("--shell-accent")).toBe(publicAccent);
    expect(fade).toBeTruthy();

    const source = transformStyleSource(codeSources[0].code, codeSources[0].id, plan);
    expect(source).toContain(`const label = "alpha-card"`);
    expect(source).toContain(`const property = "${accent}"`);
    expect(source).toContain('const publicProperty = "--accent";');
    expect(source).toContain(`const shellProperty = "${publicAccent}";`);
    expect(source).toContain(`document.querySelector(".${alpha}")`);
    expect(source).toContain(`${alpha}` + '${selected ?');
    expect(source).toContain(`" ${selected}"`);

    const css = transformCss(cssSources[0].code, cssSources[0].id, plan);
    expect(css).toContain(`.${alpha}`);
    expect(css).toContain(`.${selected}`);
    expect(css).toContain(accent);
    expect(css).toContain(publicAccent);
    expect(css).not.toContain("--accent");
    expect(css).toContain(fade);
    expect(css).toContain(".runtime-success");
    expect(css).toContain("icon.svg");
    expect(css).toContain("@media");
    expect(css).toMatch(new RegExp(`@media[^{}]*\\{\\.${alpha}\\{display:block`));
    expect(css).not.toContain(".alpha-card");
    expect(css).not.toContain("--accent-color");
    expect(css).not.toContain("fade-in");
  });
});
