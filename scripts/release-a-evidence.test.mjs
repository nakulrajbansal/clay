import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  RELEASE_A_ASSERTION_IDS, assertReleaseAEvidenceReport,
} from "./release-a-evidence-lib.mjs";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const lockfile = await readFile(new URL("pnpm-lock.yaml", root), "utf8");
const runner = await readFile(new URL("scripts/release-a-evidence.mjs", root), "utf8");

const REQUIRED_ASSERTIONS = [
  "desktop.onboarding",
  "desktop.primary-actions",
  "desktop.hidden-file-input-activation",
  "desktop.import-review",
  "desktop.import-publication",
  "desktop.import-undo",
  "desktop.activation",
  "desktop.focus",
  "desktop.live-announcement",
  "desktop.work-default",
  "desktop.iframe",
  "desktop.first-real-record",
  "desktop.sample-provenance",
  "desktop.no-early-backup",
  "mobile.onboarding",
  "mobile.activation",
  "mobile.reflow",
  "mobile.touch-targets",
  "mobile.iframe",
  "lazy.onboarding-chunk-failure",
  "lazy.checklist-chunk-failure",
  "accessibility.axe",
  "identity.source-tree",
  "identity.build-digest",
];

test("axe Playwright is declared through the root package and lock contract", () => {
  const declared = packageJson.devDependencies?.["@axe-core/playwright"];
  assert.equal(typeof declared, "string", "@axe-core/playwright must be a root devDependency");
  assert.match(runner, /from "@axe-core\/playwright";/,
    "the evidence runner must use the declared package directly");
  assert.match(lockfile,
    new RegExp(`["']?@axe-core/playwright["']?:\\r?\\n\\s+specifier: ${declared.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r?\\n\\s+version:`),
    "pnpm-lock.yaml must pin the declared @axe-core/playwright specifier");
});

test("the browser runner exposes every named Release A assertion", () => {
  for (const id of REQUIRED_ASSERTIONS)
    assert.ok(runner.includes(JSON.stringify(id)), `missing machine-checkable assertion: ${id}`);
  assert.match(runner, /assertReleaseAEvidenceReport\(/,
    "the generated report must be validated before PASS is emitted");
});

test("the browser runner binds the frozen source tree and the complete served build", () => {
  assert.match(runner, /CLAY_RELEASE_A_SOURCE_TREE/);
  assert.match(runner, /productGateBuildDigest/,
    "the complete Vite manifest/assets must contribute to build identity");
  assert.match(runner, /expectedBuildDigest/);
  assert.match(runner, /servedBuildDigest/);
  assert.match(runner, /changedSourceFiles/,
    "the report must carry exact hashes for changed source/build inputs");
  assert.match(runner, /report\.screenshots/,
    "screenshots must be content-addressed in the report");
  assert.match(runner, /sha256\(bytes\)/,
    "screenshot bytes must be hashed");
});

function validReport() {
  const tree = "a".repeat(40);
  return {
    schema: 3,
    verdict: "PASS",
    sourceIdentity: {
      sourceTree: tree,
      indexTree: tree,
      changedSourceFiles: [{
        path: "package.json", mode: "100644", gitBlob: "b".repeat(40),
        byteLength: 10, sha256: `sha256:${"c".repeat(64)}`,
      }],
    },
    buildIdentity: {
      renderedId: tree,
      buildEntry: "assets/index.js",
      expectedBuildEntry: "assets/index.js",
      expectedBuildDigest: `sha256:${"d".repeat(64)}`,
      servedBuildDigest: `sha256:${"d".repeat(64)}`,
      assetCount: 2,
    },
    assertions: RELEASE_A_ASSERTION_IDS.map(id => ({
      id,
      passed: true,
      detail: id === "desktop.primary-actions" ? {
        count: 2,
        labels: ["Import a spreadsheet", "Use a recommended starter"],
        equalClassAndStyle: true,
      } : id === "desktop.import-review" ? {
        counts: {
          "Rows in file": "5002", "Rows accepted": "5000", "Rows skipped": "1",
          "Rows truncated": "1", "Fields in file": "22", "Fields accepted": "20",
          "Fields truncated": "2",
        },
        proposedFieldCount: 20,
        appCacheUnchanged: true,
      } : id === "desktop.import-publication" ? {
        acceptedRows: 5_000, appId: "default", revision: 1,
        receipt: "operation import-operation-00001",
      } : id === "desktop.import-undo" ? {
        removedRows: 5_000, structureRetained: true, receipt: "Import undone",
      } : {},
    })),
    accessibility: Array.from({ length: 8 }, (_, index) => ({
      scenario: `scenario-${index}`, seriousOrCritical: 0, ruleIds: [],
    })),
    screenshots: Array.from({ length: 13 }, (_, index) => ({
      path: index === 0 ? "evidence/release-a-import-review-desktop.png"
        : index === 1 ? "evidence/release-a-import-published-desktop.png"
          : index === 2 ? "evidence/release-a-import-undo-desktop.png"
            : `evidence/screenshot-${index}.png`,
      byteLength: index + 1,
      sha256: `sha256:${index.toString(16).repeat(64)}`,
    })),
    unexpectedConsoleErrors: [],
    unexpectedPageErrors: [],
    externalRequests: [],
  };
}

test("report validation rejects omitted assertions and mismatched served builds", () => {
  const report = validReport();
  assert.equal(assertReleaseAEvidenceReport(report, "a".repeat(40)), report);

  const missing = structuredClone(report);
  missing.assertions.pop();
  assert.throws(() => assertReleaseAEvidenceReport(missing, "a".repeat(40)),
    /required assertion did not pass/);

  const stale = structuredClone(report);
  stale.buildIdentity.servedBuildDigest = `sha256:${"e".repeat(64)}`;
  assert.throws(() => assertReleaseAEvidenceReport(stale, "a".repeat(40)),
    /served build digest does not match/);

  const vacuous = structuredClone(report);
  vacuous.assertions.find(item => item.id === "desktop.import-review").detail = {};
  assert.throws(() => assertReleaseAEvidenceReport(vacuous, "a".repeat(40)),
    /import review evidence is not exact/);
});
