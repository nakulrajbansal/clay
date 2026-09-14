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

test("production document exposes a build-time source-tree evidence marker", async () => {
  const source = await readFile(new URL("packages/shell/index.html", root), "utf8");
  assert.match(source, /<meta name="clay-source-tree" content="%VITE_CLAY_SOURCE_TREE%" \/>/);
});

test("every actual aggregate product gate uses the shared origin resolver", async () => {
  const gates = aggregateGateNames();
  for (const gate of gates) {
    const command = packageJson.scripts[gate];
    assert.equal(typeof command, "string", `${gate} must be a package script`);
    const scriptPath = command.match(/^node (scripts\/[a-z0-9-]+\.mjs)(?: [a-zA-Z0-9/._-]+)*$/)?.[1];
    assert.ok(scriptPath, `${gate} must execute exactly one browser script`);
    const browserScriptPath = gate === "verify:local-export"
      ? "scripts/local-export-evidence.mjs" : scriptPath;
    const source = await readFile(new URL(browserScriptPath, root), "utf8");
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

test("local-export release entrypoint owns an isolated clean-HEAD certificate lifecycle", async () => {
  assert.equal(packageJson.scripts["verify:local-export"],
    "node scripts/verify-local-export.mjs");
  const wrapper = await readFile(new URL("scripts/verify-local-export.mjs", root), "utf8");
  assert.match(wrapper, /deriveCleanHeadSource\(/);
  assert.match(wrapper, /git[\s\S]*worktree[\s\S]*add[\s\S]*--detach/);
  assert.match(wrapper, /assertExactCleanSource\(/);
  assert.match(wrapper, /--offline/);
  assert.match(wrapper, /--frozen-lockfile/);
  assert.match(wrapper, /--strictPort/);
  assert.match(wrapper, /4173[\s\S]*4174[\s\S]*4175/);
  assert.match(wrapper, /resolveEvidenceOutput/);
  assert.match(wrapper, /createCertificateEnvironment\(/);
  assert.doesNotMatch(wrapper, /const env\s*=\s*\{\s*\.\.\.process\.env/s,
    "the certificate must not inherit arbitrary build-affecting environment");
  assert.match(wrapper,
    /options\.manualScreenReader[\s\S]*isInside\(repoRoot, options\.manualScreenReader\)/,
    "manual evidence input must actually be external to the authoritative source");
  assert.match(wrapper, /finally\s*\{/);
  assert.match(wrapper, /const cleanupFailures = \[\]/);
  assert.match(wrapper,
    /catch \(error\) \{ removalError = error; \}[\s\S]*?await rm\(checkout, \{ recursive: true, force: true \}\)[\s\S]*?worktreeRemovalComplete/,
    "a failed Git removal must delete the exact owned checkout before authoritative readback");
  assert.match(wrapper, /worktree[\s\S]*remove[\s\S]*worktree[\s\S]*prune/);
  assert.match(wrapper,
    /cleanup\("remove isolated temporary directory"[\s\S]*rm\(temporaryRoot, \{ recursive: true, force: true \}\)/);
  assert.match(wrapper, /local-export-browser-benchmark-evidence\.mjs/);
  assert.match(wrapper, /local-export-evidence\.mjs/);
  assert.doesNotMatch(packageJson.scripts["verify:local-export"], /local-export-evidence\.mjs/,
    "the direct browser runtime must not be the package release entrypoint");
});

test("local-export browser evidence observes real dialog states and doubles every rendered text node", async () => {
  const source = await readFile(new URL("scripts/local-export-evidence.mjs", root), "utf8");
  const styles = await readFile(new URL("packages/shell/src/app/styles.css", root), "utf8");
  const harness = await readFile(new URL(
    "packages/shell/test/browser/projection-benchmark-owner.tsx", root,
  ), "utf8");
  const browserBenchmark = await readFile(new URL(
    "scripts/local-export-browser-benchmark.mjs", root,
  ), "utf8");
  const evidenceLibrary = await readFile(new URL(
    "scripts/local-export-evidence-lib.mjs", root,
  ), "utf8");
  const benchmarkWorker = await readFile(new URL(
    "packages/shell/test/browser/projection-benchmark-worker.ts", root,
  ), "utf8");
  const exportDialog = await readFile(new URL(
    "packages/shell/src/app/ExportDialog.tsx", root,
  ), "utf8");
  const projectionPrint = await readFile(new URL(
    "packages/shell/src/app/projection-print.ts", root,
  ), "utf8");
  assert.match(harness, /import "\.\.\/\.\.\/src\/app\/Operations\.css"/,
    "the benchmark owner must load the production modal and dialog layout styles");
  assert.match(browserBenchmark, /fields:\s*30/);
  assert.match(browserBenchmark, /nearLimitPlaintextBytes/);
  assert.match(benchmarkWorker, /const FIELD_COUNT = 30/);
  assert.match(exportDialog, /const PREVIEW_PAGE_SIZE = 100/);
  assert.match(exportDialog,
    /manifest\.rowCount > PREVIEW_PAGE_SIZE[\s\S]*?Rows \{pageStart \+ 1\}–\{pageEnd\} of \{manifest\.rowCount\}/,
    "large previews must disclose the exact visible range and total");
  assert.doesNotMatch(exportDialog, /flushSync|setPage\(-1\)/,
    "native Print must never synchronously expand the React preview");
  assert.match(exportDialog,
    /await prepareProjectionPrintDocument[\s\S]*?window\.print\(\)/,
    "native Print must wait for the isolated bounded print document");
  assert.match(projectionPrint,
    /PRINT_ROWS_PER_SHEET = 150[\s\S]*?PRINT_FIELDS_PER_SHEET = 4[\s\S]*?await yieldToMain\(\)/,
    "print preparation must yield after bounded 600-cell sheets");
  assert.match(browserBenchmark,
    /expectedRows = Math\.min\(rows, 100\)[\s\S]*?projection-pagination[\s\S]*?Rows 1–\$\{expectedRows\} of \$\{rows\}/,
    "the browser benchmark must time a complete first preview page with exact total disclosure");
  assert.match(browserBenchmark,
    /renderedCells[\s\S]*?maxSheetCells > 600[\s\S]*?responsiveBeforePrint[\s\S]*?pdfTextMatchesExactSequence/,
    "the browser benchmark must certify bounded, responsive, exact maximum Print output");
  assert.match(browserBenchmark,
    /join\(outDir, "maximum-print\.pdf"\)[\s\S]*?maximumPrint[\s\S]*?rawResultsSha256/,
    "the maximum Print PDF and its measurements must be retained in benchmark evidence");
  assert.match(evidenceLibrary,
    /expectedArtifacts = \[\.\.\.runtimeArtifacts, benchmark\.maximumPrint\.artifact\]/,
    "outer release verification must rehash the retained maximum Print PDF");
  assert.match(source, /schema: "LocalExportEvidenceManifestV2"/);
  assert.match(source, /writeReleaseEvidenceDirectory\(dirname\(outDir\), report, benchmarkEvidence\)/);
  assert.doesNotMatch(source, /schema: "LocalExportEvidenceManifestV1"/);
  assert.match(source, /runExportDialogStateEvidence\(/);
  assert.match(source, /summarizeExportDialogStateEvidence\(/);
  assert.doesNotMatch(source, /states:\s*\["loading", "success", "error"\]/);
  assert.match(harness, /openState/);
  assert.doesNotMatch(browserBenchmark, /data-export-state/,
    "browser evidence must identify loading, success, and error through semantic DOM state");
  assert.match(harness, /"loading"\s*\|\s*"success"\s*\|\s*"error"/);
  assert.match(source, /NodeFilter\.SHOW_TEXT/);
  assert.match(source, /computed-font-size-per-rendered-text-node/);
  assert.match(source, /style\.setProperty\("font-size"/);
  assert.match(source, /renderedTextNodes/);
  assert.match(source, /targetReachability/);
  assert.match(source, /overflowingElements/);
  const mobileScreenshot = source.indexOf("mobile-320px-200pct.png");
  const reflowFailure = source.indexOf("320 CSS px at 200% text scale has no document-level horizontal overflow");
  assert.ok(mobileScreenshot >= 0 && reflowFailure >= 0 && mobileScreenshot < reflowFailure,
    "mobile screenshot and geometry diagnostics must exist before a reflow assertion can fail");
  assert.doesNotMatch(source,
    /document\.documentElement\.style\.setProperty\("font-size", "200%", "important"\)/);
  assert.doesNotMatch(source, /deviceScaleFactor:\s*2/);
  assert.match(source,
    /observeMobileAppbarPopover[\s\S]*?fullyInViewport[\s\S]*?hit === item \|\| item\.contains\(hit\)[\s\S]*?allItemsReachable/,
    "each popover item must be fully visible and win its own pointer hit-test");
  assert.match(source,
    /await bootData\(mobilePage,\s*"mobile",\s*\{\s*keyboard:\s*true,\s*textScalePercent:\s*200\s*\}\)/,
    "the mobile Data journey must run at actual 200% text and use keyboard activation");
  assert.match(source,
    /await reachControlByTab\(mobilePage, mobileTrigger[\s\S]*?mobilePage\.keyboard\.press\("Enter"\)/,
    "the mobile export preview must be reached by Tab and opened with Enter");
  assert.match(source,
    /reachControlByTab[\s\S]*?body\.focus\(\)[\s\S]*?keyboard\.press\("Tab"\)[\s\S]*?document\.activeElement === element/,
    "keyboard journeys must reach controls through the natural Tab order");
  assert.doesNotMatch(source, /await mobileTrigger\.focus\(\)/);
  assert.match(source,
    /lastControl\.focus\(\)[\s\S]*?keyboard\.press\("Tab"\)[\s\S]*?document\.activeElement === firstControl/,
    "Tab from the final control must wrap exactly to the first control");
  assert.match(source,
    /firstControl\.focus\(\)[\s\S]*?keyboard\.press\("Shift\+Tab"\)[\s\S]*?document\.activeElement === lastControl/,
    "Shift+Tab from the first control must wrap exactly to the final control");
  assert.match(source,
    /outside\.focus\(\)[\s\S]*?document\.activeElement !== outside[\s\S]*?activeDialog\.contains/,
    "content outside the modal must remain inert to focus");
  assert.match(source,
    /keyboard\.press\("Space"\)[\s\S]*?keyboard\.press\("Escape"\)/,
    "the mobile certificate must exercise activation and dismissal keys");
  assert.match(source, /pdfTextMatchesExactSequence\(printText, orderedPrintValues\)/,
    "the PDF certificate must compare the complete normalized print document");
  assert.match(source,
    /selectedRecordId[\s\S]*?recordFieldPairs[\s\S]*?recordHeadings[\s\S]*?recordPreviewRows/,
    "the record journey must bind identity, headings, and values");
  assert.match(source, /recordCsvRows[\s\S]*?expectedRecordCsv/,
    "the record journey must read back its exact CSV");
  assert.match(source,
    /recordPrintBaseline[\s\S]*?waitForFunction[\s\S]*?recordPrintBaseline \+ 1/,
    "the record journey must invoke native Print and await its completion");
  const desktopCsvAction = source.indexOf("const downloadPromise = page.waitForEvent");
  const desktopPrintAction = source.indexOf(
    'await dialog.getByRole("button", { name: "Print / Save as PDF", exact: true }).click()',
  );
  const desktopEgressClosure = source.indexOf("const exportEgress = assertLocalExportActionEgress");
  assert.ok(desktopCsvAction >= 0 && desktopCsvAction < desktopPrintAction
      && desktopPrintAction < desktopEgressClosure,
  "the zero-egress interval must close only after observed CSV and Print actions");
  assert.match(source,
    /blobUrls[\s\S]*?downloadUrls[\s\S]*?context\.on\("request"[\s\S]*?monitorWebSockets[\s\S]*?webSockets\.slice\(webSocketBaseline\)/,
    "the action interval must separately classify blob downloads and WebSockets");
  assert.match(harness,
    /detail[\s\S]*?quiescent[^\n]*=== true[\s\S]*?outcome[^\n]*=== "cancelled"/,
    "the benchmark must accept cancellation only with worker quiescence proof");
  assert.match(benchmarkWorker,
    /cancelProjectionV1[\s\S]*?await lifecycle\.terminal[\s\S]*?quiescent: true, outcome/,
    "the benchmark worker must acknowledge cancellation only after terminal publication");
  assert.match(source,
    /const keyboardAssertions = \[\];[\s\S]*?assertions:\s*keyboardAssertions/,
    "keyboard manifest assertions must be populated only by observed checks");
  assert.doesNotMatch(source, /assertions:\s*\[\s*"Enter opens the export preview/,
    "the certificate must not hardcode an unobserved Enter assertion");
  assert.doesNotMatch(styles,
    /@media \(max-width: 480px\)[\s\S]*?\.appbar\s*\{[^}]*overflow-x:\s*auto;/,
    "the compact app bar must not require horizontal scrolling");
  assert.match(styles,
    /@media \(max-width: 480px\)[\s\S]*?\.appbar\s*\{[^}]*flex-wrap:\s*wrap;[^}]*overflow:\s*visible;/,
    "the compact app bar must reflow all controls visibly");
  assert.match(source,
    /appbarFitsViewport[\s\S]*?scrollWidth[\s\S]*?clientWidth/,
    "the mobile certificate must measure app-bar internal overflow");
  assert.match(source,
    /targetActions[\s\S]*?rect\.left >= 0[\s\S]*?rect\.right <= innerWidth[\s\S]*?hit === element/,
    "each export action must be fully visible and win its own hit-test");
  assert.match(source, /dialogInternalHorizontalOverflow/,
    "the mobile certificate must measure dialog-level horizontal overflow");
  assert.match(styles,
    /@media \(max-width: 480px\)[\s\S]*?:is\(\.appbar-menu,\.appbar-theme-menu\)\s*\{[^}]*max-width:\s*calc\(100vw - 16px\);[^}]*max-height:\s*calc\(100dvh - 64px\);[^}]*overflow:\s*auto;/,
    "mobile app and theme menus must remain bounded and scroll within the viewport");
  assert.match(styles,
    /@media \(max-width: 720px\)[\s\S]*?\.dataview-header-actions\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/,
    "the wrapped Data actions must shrink before their internal horizontal scroll is used");
});

test("compact export controls truly reflow below the wrapped app bar", async () => {
  const styles = await readFile(new URL("packages/shell/src/app/styles.css", root), "utf8");
  const primitives = await readFile(new URL(
    "packages/shell/src/app/primitives.css", root,
  ), "utf8");
  const exportDialog = await readFile(new URL(
    "packages/shell/src/app/ExportDialog.tsx", root,
  ), "utf8");
  const exportStyles = await readFile(new URL(
    "packages/shell/src/app/ExportDialog.css", root,
  ), "utf8");
  const compact = styles.slice(styles.indexOf("@media (max-width: 480px)"));
  assert.match(compact, /\.appbar-theme\s*\{[^}]*position:\s*static;/);
  assert.match(compact,
    /\.appbar-theme-menu\s*\{[^}]*top:\s*100%;[^}]*left:\s*8px;[^}]*right:\s*8px;[^}]*width:\s*auto;/);
  assert.match(compact, /\.rail\s*\{[^}]*position:\s*absolute;[^}]*top:\s*0;/);
  assert.match(compact,
    /\.appbar-theme-btn\s+\.appbar-action-label\s*\{[^}]*display:\s*none;/);
  assert.match(exportDialog,
    /className="[^"]*ui-flex-wrap-wrap[^"]*export-redaction-options[^"]*"/,
    "the redaction controls must opt into the shared wrapping primitive");
  assert.match(primitives,
    /\.ui:where\(\.ui-flex-wrap-wrap\)\s*\{[^}]*flex-wrap:\s*wrap;/,
    "the shared wrapping primitive must remain executable CSS");
  assert.match(exportStyles,
    /\.export-redaction-options\s*\{[^}]*overflow-x:\s*visible;/,
    "the export-specific control group must not create a horizontal scroller");
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
  assert.equal(isExpectedProductGateRequest(
    PRODUCT_GATE_ORIGIN, "blob:null/4fe2e861-a6a5-4595-9d43-dfc45d90645d",
  ), true);
  assert.equal(isExpectedProductGateRequest(
    PRODUCT_GATE_ORIGIN, `blob:${PRODUCT_GATE_ORIGIN}/4fe2e861-a6a5-4595-9d43-dfc45d90645d`,
  ), true);
  assert.equal(isExpectedProductGateRequest(
    PRODUCT_GATE_ORIGIN, "blob:https://evil.example/4fe2e861-a6a5-4595-9d43-dfc45d90645d",
  ), false);
  assert.equal(isExpectedProductGateRequest(
    PRODUCT_GATE_ORIGIN, "blob:null/not-a-uuid",
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
