import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sharedRuntimeChunk } from "./config/shared-runtime-chunks.mjs";
import { createSharedSqliteRuntime } from "./config/shared-sqlite-runtime.mjs";

import {
  createProductionCssOptimizer,
  CSS_BROWSER_TARGETS,
} from "./config/css-optimizer.mjs";

const sourceTree = process.env.CLAY_SOURCE_TREE ?? process.env.VITE_CLAY_SOURCE_TREE ?? "unbound";
const sourceFingerprint = process.env.CLAY_SOURCE_FINGERPRINT ?? "unbound";
if (sourceFingerprint !== "unbound" && !/^[0-9a-f]{64}$/.test(sourceFingerprint))
  throw new Error("CLAY_SOURCE_FINGERPRINT must be an exact build-input SHA-256 or omitted");
if (sourceTree !== "unbound" && !/^[0-9a-f]{40}$/.test(sourceTree))
  throw new Error("CLAY_SOURCE_TREE must be a Git SHA-1 tree or omitted");
if (sourceTree !== "unbound") {
  const headTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (sourceTree !== headTree)
    throw new Error("CLAY_SOURCE_TREE must match the checkout's exact HEAD tree");
}

export default defineConfig({
  plugins: [
    createSharedSqliteRuntime(),
    createProductionCssOptimizer({
      sourceRoot: fileURLToPath(new URL("./src/", import.meta.url)),
    }),
    react(), {
    name: "clay-source-tree",
    transformIndexHtml: {
      order: "pre",
      handler: html => ({
        html: html.replace("%VITE_CLAY_SOURCE_TREE%", sourceTree),
        tags: [{ tag: "meta", attrs: { name: "clay-source-fingerprint", content: sourceFingerprint }, injectTo: "head" }],
      }),
    },
  }],
  build: {
    // The JavaScript baseline matches the existing CSS browser contract.
    target: CSS_BROWSER_TARGETS.vite,
    manifest: true,
    minify: "terser",
    terserOptions: { compress: { passes: 2 } },
    cssMinify: "lightningcss",
    cssTarget: CSS_BROWSER_TARGETS.vite,
    rollupOptions: {
      output: { onlyExplicitManualChunks: true, manualChunks: sharedRuntimeChunk },
    },
  },
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  worker: {
    format: "es",
    plugins: () => [createSharedSqliteRuntime()],
    rollupOptions: {
      output: {
        onlyExplicitManualChunks: true,
        manualChunks: id => sharedRuntimeChunk(id)
          ?? (id.replaceAll("\\", "/").endsWith("/planner-authority.ts")
            ? "planner-authority" : undefined),
      },
    },
  },
});
