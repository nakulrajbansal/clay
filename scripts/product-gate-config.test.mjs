import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PRODUCT_GATE_ORIGIN,
  assertProductGateOrigin,
  createProductGateOriginGuard,
  isExpectedProductGateRequest,
  monitorProductGatePage,
  productGateAssetPaths,
  productGateBuildDigest,
  productGateBuildEntry,
  productGateUrl,
} from "./product-gate-url.mjs";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));

function aggregateGateNames() {
  const aggregate = packageJson.scripts["verify:product"];
  assert.equal(typeof aggregate, "string");
  const parts = aggregate.split(/\s+&&\s+/);
  assert.ok(parts.length > 0, "verify:product must contain gates");
  const names = parts.map(part => {
    const match = part.match(/^pnpm (verify:[a-z0-9-]+)$/);
    assert.ok(match, `unsupported verify:product command: ${part}`);
    return match[1];
  });
  assert.equal(new Set(names).size, names.length, "verify:product must not repeat gates");
  return names;
}

test("every actual aggregate product gate uses the shared origin resolver", async () => {
  const gates = aggregateGateNames();
  for (const gate of gates) {
    const command = packageJson.scripts[gate];
    assert.equal(typeof command, "string", `${gate} must be a package script`);
    const scriptPath = command.match(/^node (scripts\/[a-z0-9-]+\.mjs)(?: [a-zA-Z0-9/._-]+)*$/)?.[1];
    assert.ok(scriptPath, `${gate} must execute exactly one browser script`);
    const source = await readFile(new URL(scriptPath, root), "utf8");
    assert.match(source,
      /import\s*\{[^}]*\bproductGateUrl\b[^}]*\}\s*from "\.\/product-gate-url\.mjs";/s,
      `${gate} must import the shared resolver`);
    assert.match(source, /const url = productGateUrl\(\);/,
      `${gate} must resolve its navigation URL once`);
    const navigationArgs = [...source.matchAll(/page\.goto\(\s*([^,\n)]+)/g)]
      .map(match => match[1].trim());
    assert.ok(navigationArgs.length > 0, `${gate} must navigate`);
    assert.deepEqual([...new Set(navigationArgs)], ["url"],
      `${gate} must navigate only to the shared resolved URL`);
    assert.doesNotMatch(source, /process\.env\.URL|127\.0\.0\.1:417[0-9]/,
      `${gate} must not define another origin`);
  }
});

test("workspace evidence installs navigation and exact-request guards", async () => {
  const source = await readFile(new URL("scripts/workspace-mode.mjs", root), "utf8");
  assert.match(source, /monitorProductGatePage\(page, url\)/);
  assert.ok((source.match(/assertCurrentOrigin\(\)/g) || []).length >= 3);
  assert.match(source, /isExpectedProductGateRequest\(url, request\.url\(\)\)/);
  assert.ok((source.match(/check\(externalRequests\.length === 0/g) || []).length >= 2);
  assert.match(source, /const localBuildPaths = await listLocalBuildFiles\(distRoot\)/);
  assert.match(source, /const localAssets = await Promise\.all\(localBuildPaths\.map/);
  assert.match(source, /productGateBuildDigest\(localManifest, localAssets\)/);
  assert.match(source, /productGateBuildDigest\(servedManifest, servedAssets\)/);
  assert.match(source, /buildDigest, expectedBuildDigest/);
});

test("shared product-gate helpers bind override, final origin, and manifest entry", () => {
  assert.equal(PRODUCT_GATE_ORIGIN, "http://127.0.0.1:4173");
  assert.equal(productGateUrl({}), PRODUCT_GATE_ORIGIN);
  assert.equal(productGateUrl({ URL: "http://127.0.0.1:4999" }), "http://127.0.0.1:4999");
  assert.doesNotThrow(() => assertProductGateOrigin(
    "http://127.0.0.1:4173/path", "http://127.0.0.1:4173/other",
  ));
  assert.throws(() => assertProductGateOrigin(
    "http://127.0.0.1:4173", "http://127.0.0.1:4174",
  ));
  assert.equal(productGateBuildEntry({ "index.html": { file: "assets/index-safe.js" } }),
    "assets/index-safe.js");
  assert.throws(() => productGateBuildEntry({ "index.html": { file: "../escape.js" } }));
});

test("origin guard remembers any redirect and requests require the exact origin", () => {
  const guard = createProductGateOriginGuard(PRODUCT_GATE_ORIGIN);
  guard.observe("http://127.0.0.1:4174/redirected");
  guard.observe(`${PRODUCT_GATE_ORIGIN}/returned`);
  assert.throws(() => guard.assert(`${PRODUCT_GATE_ORIGIN}/final`), /unexpected origin/);
  assert.equal(isExpectedProductGateRequest(
    PRODUCT_GATE_ORIGIN, `${PRODUCT_GATE_ORIGIN}/assets/index.js`,
  ), true);
  assert.equal(isExpectedProductGateRequest(
    PRODUCT_GATE_ORIGIN, "http://127.0.0.1:4174/assets/index.js",
  ), false);
});

test("page monitor observes every main-frame navigation and stays failed after redirect", () => {
  let listener;
  let currentUrl = PRODUCT_GATE_ORIGIN;
  const mainFrame = { url: () => currentUrl };
  const page = {
    mainFrame: () => mainFrame,
    url: () => currentUrl,
    on(event, callback) {
      assert.equal(event, "framenavigated");
      listener = callback;
    },
  };
  const assertCurrentOrigin = monitorProductGatePage(page, PRODUCT_GATE_ORIGIN);
  currentUrl = "http://127.0.0.1:4174/redirect";
  listener(mainFrame);
  currentUrl = `${PRODUCT_GATE_ORIGIN}/returned`;
  listener(mainFrame);
  assert.throws(assertCurrentOrigin, /unexpected origin/);
});

test("build digest binds the complete manifest and every emitted asset", () => {
  const manifest = {
    "index.html": {
      file: "assets/index.js",
      css: ["assets/main.css"],
      dynamicImports: ["src/lazy.ts"],
    },
    "src/lazy.ts": { file: "assets/lazy.js" },
  };
  assert.deepEqual(productGateAssetPaths(manifest), [
    "assets/index.js", "assets/lazy.js", "assets/main.css",
  ]);
  const assets = productGateAssetPaths(manifest).map((path, index) => ({
    path, size: index + 1, sha256: String(index + 1).repeat(64),
  }));
  const digest = productGateBuildDigest(manifest, assets);
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(productGateBuildDigest(manifest, [...assets].reverse()), digest);
  const changedCss = assets.map(asset => asset.path.endsWith(".css")
    ? { ...asset, sha256: "f".repeat(64) } : asset);
  assert.notEqual(productGateBuildDigest(manifest, changedCss), digest);
  const withWorker = [...assets, {
    path: "assets/db-worker.js", size: 99, sha256: "e".repeat(64),
  }];
  assert.notEqual(productGateBuildDigest(manifest, withWorker), digest);
  assert.throws(() => productGateBuildDigest(manifest, assets.slice(1)), /asset inventory/);
});
