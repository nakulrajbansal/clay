import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  analyzeManifest,
  assertBuildFresh,
  assertWithinBudget,
  collectShellJsFiles,
  collectStaticClosure,
  findEntry,
  measureFiles,
  mergeFiles,
  resolveSemanticLazyChunks,
} from "./bundle-budget-lib.mjs";

test("assertBuildFresh rejects stale artifacts with filesystem tolerance", () => {
  assert.doesNotThrow(() => assertBuildFresh("build", 10_000, 8_500));
  assert.throws(
    () => assertBuildFresh("build", 11_001, 8_000),
    /source mtime.*newer than artifact/,
  );
});

test("findEntry uses isEntry when multiple files have index names", () => {
  const manifest = {
    "src/main.tsx": {
      file: "assets/index-app.js",
      src: "src/main.tsx",
      isEntry: true,
      imports: ["_shared.js"],
    },
    "_shared.js": { file: "assets/index-shared.js" },
  };

  assert.deepEqual(findEntry(manifest), {
    key: "src/main.tsx",
    record: manifest["src/main.tsx"],
  });
});

test("collectStaticClosure recursively includes static imports", () => {
  const manifest = {
    "src/main.tsx": {
      file: "assets/index-app.js",
      imports: ["_vendor.js"],
      dynamicImports: ["src/app/DataView.tsx"],
    },
    "_vendor.js": {
      file: "assets/index-vendor.js",
      imports: ["_shared.js"],
    },
    "_shared.js": { file: "assets/shared.js" },
    "src/app/DataView.tsx": { file: "assets/DataView.js" },
  };

  assert.deepEqual(collectStaticClosure(manifest, "src/main.tsx"), {
    keys: ["_shared.js", "_vendor.js", "src/main.tsx"],
    files: [
      "assets/index-app.js",
      "assets/index-vendor.js",
      "assets/shared.js",
    ],
  });
});

test("collectShellJsFiles includes every manifest shell chunk once", () => {
  const manifest = {
    "src/main.tsx": { file: "assets/index-app.js", isEntry: true },
    "_shared-a.js": { file: "assets/shared.js" },
    "_shared-b.js": { file: "assets/shared.js" },
    "src/app/DataView.tsx": { file: "assets/DataView.js", isDynamicEntry: true },
    "src/app/styles.css": { file: "assets/index.css" },
    "src/worker/db-worker.ts": { file: "assets/db-worker-abc.js" },
    "sqlite3-worker1.js": { file: "assets/sqlite3-worker1-abc.js" },
  };

  assert.deepEqual(collectShellJsFiles(manifest), [
    "assets/DataView.js",
    "assets/index-app.js",
    "assets/shared.js",
  ]);
});

test("resolveSemanticLazyChunks rejects a missing expected boundary", () => {
  const manifest = {
    "src/app/DataView.tsx": {
      file: "assets/DataView.js",
      src: "src/app/DataView.tsx",
      isDynamicEntry: true,
    },
  };
  const expected = [
    { label: "DataView", source: "src/app/DataView.tsx" },
    { label: "HistoryView", source: "src/app/HistoryView.tsx" },
  ];

  assert.throws(
    () => resolveSemanticLazyChunks(manifest, expected),
    /missing expected lazy chunk HistoryView \(src\/app\/HistoryView\.tsx\)/,
  );
});

test("analyzeManifest keeps dynamic chunks outside the entry closure", () => {
  const manifest = {
    "src/main.tsx": {
      file: "assets/index-app.js",
      isEntry: true,
      imports: ["_shared.js"],
      dynamicImports: ["src/app/DataView.tsx"],
    },
    "_shared.js": { file: "assets/shared.js" },
    "src/app/DataView.tsx": {
      file: "assets/DataView.js",
      src: "src/app/DataView.tsx",
      isDynamicEntry: true,
      imports: ["_shared.js"],
    },
  };

  const analysis = analyzeManifest(manifest);
  assert.deepEqual(analysis.entryClosure.files, [
    "assets/index-app.js",
    "assets/shared.js",
  ]);
  assert.deepEqual(analysis.totalShellJsFiles, [
    "assets/DataView.js",
    "assets/index-app.js",
    "assets/shared.js",
  ]);
});

test("analyzeManifest reports each semantic chunk closure", () => {
  const manifest = {
    "src/main.tsx": {
      file: "assets/index-app.js",
      isEntry: true,
      dynamicImports: ["src/app/DataView.tsx"],
    },
    "src/app/DataView.tsx": {
      file: "assets/DataView.js",
      src: "src/app/DataView.tsx",
      isDynamicEntry: true,
      imports: ["_dialog.js"],
    },
    "_dialog.js": { file: "assets/dialog.js" },
  };

  const analysis = analyzeManifest(manifest, {
    expectedLazyChunks: [
      { label: "DataView", source: "src/app/DataView.tsx" },
    ],
  });
  assert.deepEqual(analysis.lazyChunks, [
    {
      label: "DataView",
      source: "src/app/DataView.tsx",
      key: "src/app/DataView.tsx",
      closure: {
        keys: ["_dialog.js", "src/app/DataView.tsx"],
        files: ["assets/DataView.js", "assets/dialog.js"],
      },
    },
  ]);
});

test("analyzeManifest rejects a semantic chunk in the static entry closure", () => {
  const manifest = {
    "src/main.tsx": {
      file: "assets/index-app.js",
      isEntry: true,
      imports: ["src/app/DataView.tsx"],
      dynamicImports: ["src/app/DataView.tsx"],
    },
    "src/app/DataView.tsx": {
      file: "assets/DataView.js",
      src: "src/app/DataView.tsx",
      isDynamicEntry: true,
    },
  };

  assert.throws(
    () => analyzeManifest(manifest, {
      expectedLazyChunks: [
        { label: "DataView", source: "src/app/DataView.tsx" },
      ],
    }),
    /DataView.*static entry closure/,
  );
});

test("analyzeManifest permits shared dependencies across closures", () => {
  const manifest = {
    "src/main.tsx": {
      file: "assets/index-app.js",
      isEntry: true,
      imports: ["_react.js"],
      dynamicImports: ["src/app/DataView.tsx"],
    },
    "src/app/DataView.tsx": {
      file: "assets/DataView.js",
      src: "src/app/DataView.tsx",
      isDynamicEntry: true,
      imports: ["_react.js"],
    },
    "_react.js": { file: "assets/react.js" },
  };

  const analysis = analyzeManifest(manifest, {
    expectedLazyChunks: [
      { label: "DataView", source: "src/app/DataView.tsx" },
    ],
  });
  assert.deepEqual(analysis.lazyChunks[0].closure.files, ["assets/DataView.js"]);
});

test("mergeFiles counts shared entry and warm-surface assets once", () => {
  assert.deepEqual(
    mergeFiles(
      ["assets/index.js", "assets/react.js"],
      ["assets/PanelCanvas.js", "assets/react.js"],
    ),
    ["assets/PanelCanvas.js", "assets/index.js", "assets/react.js"],
  );
});

test("measureFiles reports per-file and closure byte totals", async t => {
  const root = await mkdtemp(join(tmpdir(), "clay-bundle-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "assets"));

  const app = Buffer.from("application chunk application chunk");
  const shared = Buffer.from("shared chunk");
  await writeFile(join(root, "assets", "app.js"), app);
  await writeFile(join(root, "assets", "shared.js"), shared);

  const result = await measureFiles(root, [
    "assets/shared.js",
    "assets/app.js",
  ]);
  assert.deepEqual(result, {
    files: [
      {
        file: "assets/app.js",
        raw: app.byteLength,
        gzip: gzipSync(app).byteLength,
      },
      {
        file: "assets/shared.js",
        raw: shared.byteLength,
        gzip: gzipSync(shared).byteLength,
      },
    ],
    raw: app.byteLength + shared.byteLength,
    gzip: gzipSync(app).byteLength + gzipSync(shared).byteLength,
  });
});

test("assertWithinBudget rejects a closure over either byte limit", () => {
  assert.throws(
    () => assertWithinBudget(
      "static entry closure",
      { raw: 726_000, gzip: 219_000 },
      { raw: 725_000, gzip: 220_000 },
    ),
    /static entry closure: 726000 B raw \/ 219000 B gzip exceeds 725000 B \/ 220000 B/,
  );
  assert.throws(
    () => assertWithinBudget(
      "static entry closure",
      { raw: 724_000, gzip: 221_000 },
      { raw: 725_000, gzip: 220_000 },
    ),
    /static entry closure: 724000 B raw \/ 221000 B gzip exceeds 725000 B \/ 220000 B/,
  );
});
