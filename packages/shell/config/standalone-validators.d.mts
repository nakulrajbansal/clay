import type { Plugin } from "vite";
export interface StandaloneModuleChunk {
  file: string;
  modules: readonly { id: string; rendered: number }[];
}
export function assertStandaloneModules(chunks: readonly StandaloneModuleChunk[], requireRuntime?: boolean): void;
export function productionStandaloneGuard(options?: Readonly<{ verifyInputs?: boolean }>): Plugin;
