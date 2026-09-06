import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, posix } from "node:path";
import { gzipSync } from "node:zlib";

const requireFromKernel = createRequire(
  new URL("../packages/kernel/package.json", import.meta.url),
);
const { parse } = requireFromKernel("acorn");

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

function importedJavaScriptSpecifiers(source) {
  const root = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowHashBang: true,
  });
  const specifiers = new Set();
  const pending = [root];

  while (pending.length > 0) {
    const node = pending.pop();
    if (!node || typeof node !== "object") continue;
    if ((node.type === "ImportDeclaration"
        || node.type === "ExportNamedDeclaration"
        || node.type === "ExportAllDeclaration")
        && typeof node.source?.value === "string") {
      specifiers.add(node.source.value);
    } else if (node.type === "ImportExpression"
        && typeof node.source?.value === "string") {
      specifiers.add(node.source.value);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) pending.push(...value);
      else if (value && typeof value === "object") pending.push(value);
    }
  }

  return [...specifiers].sort();
}

function resolveImportedJavaScript(importer, specifier) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const path = specifier.replace(/[?#].*$/, "");
  if (!path.endsWith(".js")) return null;
  const resolved = posix.normalize(posix.join(posix.dirname(importer), path));
  if (resolved === ".." || resolved.startsWith("../") || posix.isAbsolute(resolved)) {
    throw new Error(`bundle asset: import ${specifier} escapes the artifact root`);
  }
  return resolved;
}

export async function collectAssetJavaScriptClosure(root, rootFile) {
  const files = new Set();

  async function visit(file) {
    if (files.has(file)) return;
    files.add(file);
    const source = await readFile(join(root, file), "utf8");
    for (const specifier of importedJavaScriptSpecifiers(source)) {
      const importedFile = resolveImportedJavaScript(file, specifier);
      if (importedFile) await visit(importedFile);
    }
  }

  await visit(rootFile.replaceAll("\\", "/"));
  return [...files].sort();
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
  return [key, record.src]
    .filter(value => typeof value === "string")
    .map(normalizeSource)
    .some(value => value === expected || value.endsWith(`/${expected}`));
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

export function analyzeManifest(manifest, { expectedLazyChunks = [] } = {}) {
  const entry = findEntry(manifest);
  const entryClosure = collectStaticClosure(manifest, entry.key);
  const lazyChunks = resolveSemanticLazyChunks(manifest, expectedLazyChunks)
    .map(({ label, source, key }) => {
      const fullClosure = collectStaticClosure(manifest, key);
      return {
        label,
        source,
        key,
        closure: {
          keys: fullClosure.keys.filter(item => !entryClosure.keys.includes(item)),
          files: fullClosure.files.filter(file => !entryClosure.files.includes(file)),
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
