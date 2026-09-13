import type { Plugin } from "vite";
export const CSS_BROWSER_TARGETS: Readonly<{ browserslist: string[]; vite: string[] }>;
export function createProductionCssOptimizer(options: { sourceRoot: string }): Plugin;
