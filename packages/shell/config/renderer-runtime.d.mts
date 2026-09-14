import type { Alias, Plugin } from "vite";
export const rendererAliases: Alias[];
export function productionRendererGuard(): Plugin;
export function assertRendererModules(chunks: Array<{ file: string; runtime?: string; modules: Array<{ id: string; rendered: number }> }>): void;
export function assertPlannerTransportModules(chunks: Array<{ file: string; runtime?: string; modules: Array<{ id: string; rendered: number }> }>, requireWorker?: boolean): void;
