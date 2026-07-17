// Selectable color schemes (per-app). A theme is a set of design-token values
// applied BOTH to the trusted shell (document root) and injected into every
// sandboxed panel iframe (which is a separate document, so vars can't cascade
// in). Neutrals are themed too, so dark modes work. Semantic tones
// (green/amber/red) stay constant — status colour shouldn't change with vibe.

export type ThemeVars = {
  bg: string; panel: string; border: string; borderStrong: string; border2: string;
  bgSoft: string; text: string; text2: string; text3: string;
  accent: string; accentHover: string; accentSoft: string; accentText: string;
  chartArea: string;
};
export type Theme = { id: string; name: string; dark?: boolean; vars: ThemeVars };

const LIGHT = {
  panel: "#ffffff", border: "#efeef3", borderStrong: "#e6e4ee", border2: "#e7e5ee",
  bgSoft: "#f8f7fb", text: "#2b2a33", text2: "#6d6b78", text3: "#75737e",
};
function light(
  id: string, name: string, bg: string,
  accent: string, accentHover: string, accentSoft: string, accentText: string, chartArea: string,
): Theme {
  return { id, name, vars: { ...LIGHT, bg, accent, accentHover, accentSoft, accentText, chartArea } };
}
function dark(
  id: string, name: string,
  v: Partial<ThemeVars> & Pick<ThemeVars, "bg" | "panel" | "accent" | "accentSoft" | "accentText" | "chartArea">,
): Theme {
  return {
    id, name, dark: true,
    vars: {
      border: "#2a2a37", borderStrong: "#35354c", border2: "#2a2a37", bgSoft: "#22222e",
      text: "#e8e7ef", text2: "#a8a6b8", text3: "#8f8da4", accentHover: v.accent,
      ...v,
    } as ThemeVars,
  };
}

export const THEMES: Theme[] = [
  light("indigo", "Indigo", "#f7f6f9", "#6a67e6", "#5b58dc", "#f1f0fc", "#4b47c4", "rgba(106,103,230,.12)"),
  light("violet", "Violet", "#f8f6fc", "#8b5cf6", "#7c48f0", "#f3edfe", "#6d3fd4", "rgba(139,92,246,.12)"),
  light("emerald", "Emerald", "#f5f8f6", "#10b981", "#0e9f70", "#e5f7f0", "#0b7a5e", "rgba(16,185,129,.12)"),
  light("sky", "Sky", "#f5f8fb", "#2f8fd8", "#2680c6", "#e8f3fc", "#1f6fb0", "rgba(47,143,216,.12)"),
  light("rose", "Rose", "#faf6f8", "#ec4899", "#e0357f", "#fdeef5", "#bd2e70", "rgba(236,72,153,.11)"),
  light("amber", "Amber", "#faf7f2", "#e08c00", "#c97d00", "#fdf3e0", "#9a6200", "rgba(224,140,0,.12)"),
  light("graphite", "Graphite", "#f6f6f8", "#5b6472", "#4c5563", "#eef0f3", "#3a4150", "rgba(91,100,114,.12)"),
  dark("midnight", "Midnight", {
    bg: "#131319", panel: "#1b1b24", accent: "#7d7aec", accentHover: "#8f8cf0",
    accentSoft: "#29273f", accentText: "#bcb9f6", chartArea: "rgba(125,122,236,.16)",
  }),
  dark("ocean", "Ocean", {
    bg: "#0f1720", panel: "#172230", border: "#25313f", borderStrong: "#2f3e50", border2: "#25313f",
    bgSoft: "#1a2735", text: "#e6edf3", text2: "#9fb0c0", text3: "#8299ad",
    accent: "#38bdf8", accentHover: "#56c9fa", accentSoft: "#0f3348", accentText: "#7dd3fc",
    chartArea: "rgba(56,189,248,.16)",
  }),
  dark("plum", "Plum", {
    bg: "#160f1c", panel: "#1f1628", border: "#33263f", borderStrong: "#3f2f4d", border2: "#33263f",
    bgSoft: "#261a30", text: "#efe7f3", text2: "#b6a6bf", text3: "#98859f",
    accent: "#c084fc", accentHover: "#cf9bfd", accentSoft: "#3a2647", accentText: "#e0c3fe",
    chartArea: "rgba(192,132,252,.16)",
  }),
];

export const DEFAULT_THEME_ID = "ocean";
export function themeById(id: string | null | undefined): Theme {
  return THEMES.find(t => t.id === id) ?? THEMES[0]!;
}

// per-app persistence (localStorage; a view preference, not versioned data)
const key = (appId: string): string => `clay_theme_${appId}`;
export function getThemeId(appId: string | null): string {
  if (!appId) return DEFAULT_THEME_ID;
  try { return localStorage.getItem(key(appId)) ?? DEFAULT_THEME_ID; } catch { return DEFAULT_THEME_ID; }
}
export function setThemeId(appId: string, id: string): void {
  try { localStorage.setItem(key(appId), id); } catch { /* private mode */ }
}

// css var name (kebab) per token
const CSS: Record<keyof ThemeVars, string> = {
  bg: "--bg", panel: "--panel", border: "--border", borderStrong: "--border-strong",
  border2: "--border-2", bgSoft: "--bg-soft", text: "--text", text2: "--text-2", text3: "--text-3",
  accent: "--accent", accentHover: "--accent-hover", accentSoft: "--accent-soft",
  accentText: "--accent-text", chartArea: "--chart-area",
};

/** Apply a theme to the trusted shell (document root) live. */
export function applyThemeToRoot(theme: Theme): void {
  const root = document.documentElement;
  for (const [k, cssVar] of Object.entries(CSS))
    root.style.setProperty(cssVar, theme.vars[k as keyof ThemeVars]);
  root.style.colorScheme = theme.dark ? "dark" : "light";
  root.dataset.theme = theme.id;
}

// Categorical chart series (ADR-023). Two steppings of the same hues, each
// set validated (lightness band, chroma floor, adjacent CVD ΔE, normal-vision
// floor) against its surfaces via the dataviz palette validator. The ORDER is
// the colorblind-safety mechanism — never reorder, extend, or cycle without
// re-validating.
const SERIES_LIGHT = ["#6a67e6", "#008300", "#e87ba4", "#eda100", "#1baf7a", "#eb6834"];
const SERIES_DARK = ["#7d7aec", "#00a300", "#d55181", "#c98500", "#199e70", "#d95926"];

/** A :root override block to inject into a panel iframe's srcdoc. */
export function panelThemeCss(theme: Theme): string {
  const decls = Object.entries(CSS)
    .map(([k, cssVar]) => `${cssVar}:${theme.vars[k as keyof ThemeVars]}`).join(";");
  const series = (theme.dark ? SERIES_DARK : SERIES_LIGHT)
    .map((c, i) => `--series-${i + 1}:${c}`).join(";");
  // semantic tone steps: same hue meanings, re-stepped per mode so badge
  // and chip text meets WCAG AA on dark surfaces too (axe launch gate)
  const tones = theme.dark
    ? "--tone-green-bg:#173a24;--tone-green-fg:#8ce3ad;--tone-amber-bg:#3b2c10;"
      + "--tone-amber-fg:#f4c26f;--tone-red-bg:#421d1d;--tone-red-fg:#f6a5a5;"
      + "--tone-gray-bg:#2c2c39;--tone-gray-fg:#c7c5d2"
    : "--tone-green-bg:#e7f6ec;--tone-green-fg:#116632;--tone-amber-bg:#fdf0d5;"
      + "--tone-amber-fg:#92400e;--tone-red-bg:#fdeaea;--tone-red-fg:#a61e1e;"
      + "--tone-gray-bg:#f0f0f3;--tone-gray-fg:#4d4b57";
  return `:root{color-scheme:${theme.dark ? "dark" : "light"};${decls};${series};${tones}}`;
}
