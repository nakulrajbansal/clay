import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    manifest: true,
  },
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  worker: {
    format: "es",
    rollupOptions: {
      output: {
        onlyExplicitManualChunks: true,
        manualChunks: id => id.replaceAll("\\", "/").endsWith("/planner-authority.ts")
          ? "planner-authority" : undefined,
      },
    },
  },
});
