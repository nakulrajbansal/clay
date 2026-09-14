import type { Plugin } from "vite";
export function assertPureComputeModules(ids: readonly string[]): void;
export function assertComputeSource(source: string, mode?: "pure" | "private-entry"): void;
export function productionPureComputeGuard(options?: { verifyInputs?: boolean }): Plugin;
