import { createHash } from "node:crypto";

export const PRODUCT_GATE_ORIGIN = "http://127.0.0.1:4173";

export function productGateUrl(env = process.env) {
  const value = typeof env.URL === "string" && env.URL.trim() ? env.URL.trim() : PRODUCT_GATE_ORIGIN;
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error("product gate URL must use HTTP or HTTPS");
  return parsed.href.replace(/\/$/, "");
}

export function assertProductGateOrigin(expectedUrl, finalUrl) {
  const expected = new URL(expectedUrl);
  const actual = new URL(finalUrl);
  if (actual.origin !== expected.origin)
    throw new Error(`product gate navigated to unexpected origin ${actual.origin}`);
}

export function isExpectedProductGateRequest(expectedUrl, requestUrl) {
  try {
    return new URL(requestUrl).origin === new URL(expectedUrl).origin;
  } catch {
    return false;
  }
}

export function createProductGateOriginGuard(expectedUrl) {
  let unexpectedOrigin = null;
  return {
    observe(actualUrl) {
      try {
        assertProductGateOrigin(expectedUrl, actualUrl);
      } catch {
        unexpectedOrigin ??= new URL(actualUrl).origin;
      }
    },
    assert(actualUrl) {
      assertProductGateOrigin(expectedUrl, actualUrl);
      if (unexpectedOrigin !== null)
        throw new Error(`product gate visited unexpected origin ${unexpectedOrigin}`);
    },
  };
}

export function monitorProductGatePage(page, expectedUrl) {
  const guard = createProductGateOriginGuard(expectedUrl);
  page.on("framenavigated", frame => {
    if (frame === page.mainFrame()) guard.observe(frame.url());
  });
  return () => guard.assert(page.url());
}

export function productGateBuildEntry(manifest) {
  const file = manifest?.["index.html"]?.file;
  if (typeof file !== "string" || !/^assets\/[A-Za-z0-9._-]+\.js$/.test(file))
    throw new Error("product gate manifest has no canonical entry");
  return file;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("product gate manifest is not canonical JSON");
}

function assertAssetPath(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\\")
      || path.startsWith("/") || path.split("/").includes("..")
      || !/^[A-Za-z0-9._/-]+$/.test(path))
    throw new Error("product gate manifest has an invalid asset path");
  return path;
}

export function productGateAssetPaths(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new Error("product gate manifest is invalid");
  const paths = new Set();
  for (const entry of Object.values(manifest)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("product gate manifest entry is invalid");
    if ("file" in entry) paths.add(assertAssetPath(entry.file));
    for (const field of ["css", "assets"]) {
      if (!(field in entry)) continue;
      if (!Array.isArray(entry[field])) throw new Error("product gate manifest asset list is invalid");
      for (const path of entry[field]) paths.add(assertAssetPath(path));
    }
  }
  if (paths.size === 0) throw new Error("product gate manifest has no assets");
  return [...paths].sort();
}

export function productGateBuildDigest(manifest, assets) {
  const expectedPaths = productGateAssetPaths(manifest);
  if (!Array.isArray(assets)) throw new Error("product gate asset inventory is invalid");
  const normalized = assets.map(asset => {
    const path = assertAssetPath(asset?.path);
    if (!Number.isSafeInteger(asset?.size) || asset.size < 0
        || typeof asset?.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(asset.sha256))
      throw new Error("product gate asset inventory is invalid");
    return { path, size: asset.size, sha256: asset.sha256 };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const actualPaths = new Set(normalized.map(asset => asset.path));
  if (actualPaths.size !== normalized.length
      || expectedPaths.some(path => !actualPaths.has(path)))
    throw new Error("product gate asset inventory does not match manifest");
  const descriptor = canonicalJson({ schema: 1, manifest, assets: normalized });
  return `sha256:${createHash("sha256").update(descriptor).digest("hex")}`;
}
