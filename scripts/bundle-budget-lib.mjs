import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";

export function findEntry(manifest) {
  const entries = Object.entries(manifest)
    .filter(([, record]) => record.isEntry)
    .map(([key, record]) => ({ key, record }));

  if (entries.length !== 1) {
    throw new Error(`bundle manifest: expected one entry, found ${entries.length}`);
  }

  return entries[0];
}

export function collectStaticClosure(manifest, rootKey) {
  const keys = new Set();
  const files = new Set();

  function visit(key) {
    if (keys.has(key)) return;
    const record = manifest[key];
    if (!record) {
      throw new Error(`bundle manifest: missing imported record ${key}`);
    }

    keys.add(key);
    files.add(record.file);
    for (const importedKey of record.imports ?? []) visit(importedKey);
  }

  visit(rootKey);
  return {
    keys: [...keys].sort(),
    files: [...files].sort(),
  };
}

const WORKER_ASSET = /(?:^|\/)(?:db-worker|sqlite3-worker1|sqlite3-opfs-async-proxy)-[^/]+\.js$/;

export function collectShellJsFiles(manifest) {
  return [...new Set(Object.values(manifest).map(record => record.file))]
    .filter(file => file.endsWith(".js") && !WORKER_ASSET.test(file))
    .sort();
}

export function mergeFiles(...fileGroups) {
  return [...new Set(fileGroups.flat())].sort();
}

// Vite's manifest describes the build but is not fetched by the browser.
// Every other regular file emitted under shell/dist is runtime payload.
const DOCUMENTED_BUILD_METADATA = new Set([".vite/manifest.json"]);

export async function collectEmittedRuntimeFiles(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await collectEmittedRuntimeFiles(root, path));
    else if (entry.isFile()) {
      const file = relative(root, path).replaceAll("\\", "/");
      if (!DOCUMENTED_BUILD_METADATA.has(file)) files.push(file);
    } else throw new Error(`bundle runtime inventory contains unsupported entry ${path}`);
  }
  return files.sort();
}

export async function measureFiles(root, files) {
  const measured = [];
  for (const file of mergeFiles(files)) {
    const contents = await readFile(join(root, file));
    measured.push({
      file,
      raw: contents.byteLength,
      gzip: gzipSync(contents).byteLength,
    });
  }

  return {
    files: measured,
    raw: measured.reduce((total, file) => total + file.raw, 0),
    gzip: measured.reduce((total, file) => total + file.gzip, 0),
  };
}

export function assertWithinBudget(label, measured, limits) {
  if (measured.raw > limits.raw || measured.gzip > limits.gzip) {
    throw new Error(
      `${label}: ${measured.raw} B raw / ${measured.gzip} B gzip exceeds `
      + `${limits.raw} B / ${limits.gzip} B`,
    );
  }
}

export function assertBuildFresh(label, newestSourceMs, oldestArtifactMs, toleranceMs = 2_000) {
  if (newestSourceMs > oldestArtifactMs + toleranceMs) {
    throw new Error(
      `${label}: source mtime ${newestSourceMs} is newer than artifact mtime ${oldestArtifactMs}`,
    );
  }
}

function normalizeSource(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function sourceMatches(key, record, expectedSource) {
  const expected = normalizeSource(expectedSource);
  const direct = [key, record.src]
    .filter(value => typeof value === "string")
    .map(normalizeSource)
    .some(value => value === expected || value.endsWith(`/${expected}`));
  if (direct) return true;
  const filename = expected.split("/").at(-1) ?? "";
  const stem = filename.replace(/\.[^.]+$/, "");
  return typeof record.name === "string" && record.name === stem;
}

export function resolveSemanticLazyChunks(manifest, expectedChunks) {
  return expectedChunks.map(expected => {
    const matches = Object.entries(manifest)
      .filter(([key, record]) => sourceMatches(key, record, expected.source));

    if (matches.length === 0) {
      throw new Error(
        `bundle manifest: missing expected lazy chunk ${expected.label} (${expected.source})`,
      );
    }
    if (matches.length !== 1) {
      throw new Error(
        `bundle manifest: expected one lazy chunk ${expected.label}, found ${matches.length}`,
      );
    }

    const [key, record] = matches[0];
    if (!record.isDynamicEntry) {
      throw new Error(
        `bundle manifest: expected ${expected.label} (${expected.source}) to be a dynamic entry`,
      );
    }
    return { ...expected, key, record };
  });
}

function dynamicChildren(manifest, closureKeys, loadedKeys) {
  const children = new Set();
  for (const key of closureKeys) {
    if (loadedKeys.has(key)) continue;
    for (const child of manifest[key].dynamicImports ?? []) {
      if (!manifest[child]) {
        throw new Error(`bundle manifest: missing dynamically imported record ${child}`);
      }
      children.add(child);
    }
  }
  return [...children].sort();
}

function intersectPathSets(paths, field) {
  const common = new Set(paths[0][field]);
  for (const path of paths.slice(1)) {
    for (const value of common) if (!path[field].has(value)) common.delete(value);
  }
  return common;
}

function collectGuaranteedPriorClosure(manifest, entryKey, targetKey) {
  const paths = [];

  function visit(rootKey, prior, activeRoots) {
    if (rootKey === targetKey) {
      paths.push(prior);
      return;
    }
    const closure = collectStaticClosure(manifest, rootKey);
    const loaded = {
      keys: new Set([...prior.keys, ...closure.keys]),
      files: new Set([...prior.files, ...closure.files]),
    };
    const nextActiveRoots = new Set(activeRoots).add(rootKey);
    for (const child of dynamicChildren(manifest, closure.keys, prior.keys)) {
      if (!nextActiveRoots.has(child)) visit(child, loaded, nextActiveRoots);
    }
  }

  visit(entryKey, { keys: new Set(), files: new Set() }, new Set());
  if (paths.length === 0) {
    throw new Error(`bundle manifest: lazy chunk ${targetKey} is not reachable from the entry`);
  }

  // Only subtract assets loaded on every activation path. This handles nested
  // lazy boundaries without understating a chunk that has alternate parents.
  return {
    keys: intersectPathSets(paths, "keys"),
    files: intersectPathSets(paths, "files"),
  };
}

export function analyzeManifest(manifest, { expectedLazyChunks = [] } = {}) {
  const entry = findEntry(manifest);
  const entryClosure = collectStaticClosure(manifest, entry.key);
  const lazyChunks = resolveSemanticLazyChunks(manifest, expectedLazyChunks)
    .map(({ label, source, key }) => {
      const fullClosure = collectStaticClosure(manifest, key);
      const priorClosure = collectGuaranteedPriorClosure(manifest, entry.key, key);
      return {
        label,
        source,
        key,
        closure: {
          keys: fullClosure.keys.filter(item => !priorClosure.keys.has(item)),
          files: fullClosure.files.filter(file => !priorClosure.files.has(file)),
        },
      };
    });

  for (const chunk of lazyChunks) {
    const rootFile = manifest[chunk.key].file;
    if (entryClosure.keys.includes(chunk.key)
        || entryClosure.files.includes(rootFile)) {
      throw new Error(
        `bundle manifest: ${chunk.label} is present in the static entry closure`,
      );
    }
  }

  return {
    entry,
    entryClosure,
    lazyChunks,
    totalShellJsFiles: collectShellJsFiles(manifest),
  };
}
