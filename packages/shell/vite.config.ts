import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { execFileSync } from "node:child_process";

const sourceTree = process.env.CLAY_SOURCE_TREE ?? "unbound";
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
  plugins: [react(), {
    name: "clay-source-tree",
    transformIndexHtml: () => [{
      tag: "meta", attrs: { name: "clay-source-tree", content: sourceTree }, injectTo: "head",
    }],
  }],
  build: {
    manifest: true,
    minify: "terser",
    terserOptions: { compress: { passes: 2 } },
    cssMinify: "lightningcss",
    cssTarget: ["chrome111", "firefox113", "safari16.2"],
  },
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  worker: {
    format: "es",
  },
});
