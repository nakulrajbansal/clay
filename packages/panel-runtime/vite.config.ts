import { defineConfig } from "vite";

// Builds the iframe bootstrap to one self-contained IIFE file that the
// shell inlines into panel srcdoc documents (doc 06 §2: the fixed
// bootstrap; no external requests possible under the panel CSP).
export default defineConfig({
  build: {
    lib: {
      entry: "src/iframe-entry.ts",
      name: "ClayPanelRuntime",
      formats: ["iife"],
      fileName: () => "panel-runtime.iife.js",
    },
    outDir: "dist",
    emptyOutDir: true,
    minify: false,
  },
});
