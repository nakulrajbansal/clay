export default {
  define: {
    __CLAY_TESTED_SOURCE_TREE__: JSON.stringify(
      process.env.CLAY_TESTED_SOURCE_TREE ?? "UNBOUND",
    ),
  },
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  worker: { format: "es" },
};
