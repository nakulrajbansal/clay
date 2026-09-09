const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GIT_TREE = /^[0-9a-f]{40}$/;

export const RELEASE_A_ASSERTION_IDS = Object.freeze([
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
]);

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireEvidence(condition, message) {
  if (!condition) throw new Error(`invalid Release A evidence: ${message}`);
}

export function assertReleaseAEvidenceReport(report, expectedSourceTree) {
  requireEvidence(object(report), "report must be an object");
  requireEvidence(report.schema === 3, "schema must be 3");
  requireEvidence(report.verdict === "PASS", "verdict must be PASS");
  requireEvidence(GIT_TREE.test(expectedSourceTree), "expected source tree is invalid");
  requireEvidence(object(report.sourceIdentity), "source identity is missing");
  requireEvidence(report.sourceIdentity.sourceTree === expectedSourceTree,
    "source tree does not match the frozen tree");
  requireEvidence(report.sourceIdentity.indexTree === expectedSourceTree,
    "index tree does not match the frozen tree");
  requireEvidence(Array.isArray(report.sourceIdentity.changedSourceFiles)
    && report.sourceIdentity.changedSourceFiles.length > 0,
  "changed source hashes are missing");
  const sourcePaths = new Set();
  for (const file of report.sourceIdentity.changedSourceFiles) {
    requireEvidence(object(file) && typeof file.path === "string" && file.path.length > 0,
      "changed source path is invalid");
    requireEvidence(!sourcePaths.has(file.path), `duplicate changed source path ${file.path}`);
    sourcePaths.add(file.path);
    requireEvidence(/^[0-9a-f]{40}$/.test(file.gitBlob), `Git blob is invalid for ${file.path}`);
    requireEvidence(SHA256.test(file.sha256), `SHA-256 is invalid for ${file.path}`);
    requireEvidence(Number.isSafeInteger(file.byteLength) && file.byteLength >= 0,
      `byte length is invalid for ${file.path}`);
  }

  requireEvidence(object(report.buildIdentity), "build identity is missing");
  requireEvidence(report.buildIdentity.renderedId === expectedSourceTree,
    "rendered build id does not match source tree");
  requireEvidence(typeof report.buildIdentity.buildEntry === "string"
    && report.buildIdentity.buildEntry === report.buildIdentity.expectedBuildEntry,
  "served build entry does not match local build");
  requireEvidence(SHA256.test(report.buildIdentity.expectedBuildDigest)
    && report.buildIdentity.servedBuildDigest === report.buildIdentity.expectedBuildDigest,
  "served build digest does not match local build");
  requireEvidence(Number.isSafeInteger(report.buildIdentity.assetCount)
    && report.buildIdentity.assetCount > 0, "build asset count is invalid");

  requireEvidence(Array.isArray(report.assertions), "assertion results are missing");
  const assertions = new Map(report.assertions.map(assertion => [assertion?.id, assertion]));
  requireEvidence(assertions.size === report.assertions.length,
    "assertion results contain duplicate ids");
  for (const id of RELEASE_A_ASSERTION_IDS) {
    const assertion = assertions.get(id);
    requireEvidence(object(assertion) && assertion.passed === true,
      `required assertion did not pass: ${id}`);
    requireEvidence("detail" in assertion, `required assertion has no detail: ${id}`);
  }
  requireEvidence(assertions.size === RELEASE_A_ASSERTION_IDS.length,
    "assertion results contain unknown ids");

  const primary = assertions.get("desktop.primary-actions").detail;
  requireEvidence(object(primary) && primary.count === 2
    && Array.isArray(primary.labels) && primary.labels.length === 2
    && primary.labels[0].includes("Import a spreadsheet")
    && primary.labels[1].includes("Use a recommended starter")
    && primary.equalClassAndStyle === true,
  "primary action evidence is not exact or equal priority");
  const importReview = assertions.get("desktop.import-review").detail;
  const counts = importReview?.counts;
  requireEvidence(object(importReview) && object(counts)
    && counts["Rows in file"] === "5002"
    && counts["Rows accepted"] === "5000"
    && counts["Rows skipped"] === "1"
    && counts["Rows truncated"] === "1"
    && counts["Fields in file"] === "22"
    && counts["Fields accepted"] === "20"
    && counts["Fields truncated"] === "2"
    && importReview.proposedFieldCount === 20
    && importReview.appCacheUnchanged === true,
  "import review evidence is not exact");
  const publication = assertions.get("desktop.import-publication").detail;
  requireEvidence(object(publication) && publication.acceptedRows === 5_000
    && publication.appId === "default" && publication.revision === 1
    && typeof publication.receipt === "string" && publication.receipt.includes("operation import-"),
  "import publication receipt is incomplete");
  const undo = assertions.get("desktop.import-undo").detail;
  requireEvidence(object(undo) && undo.removedRows === 5_000
    && undo.structureRetained === true && typeof undo.receipt === "string",
  "import Undo evidence is incomplete");

  requireEvidence(Array.isArray(report.accessibility) && report.accessibility.length >= 8,
    "accessibility results are incomplete");
  for (const result of report.accessibility) {
    requireEvidence(object(result) && result.seriousOrCritical === 0
      && Array.isArray(result.ruleIds) && result.ruleIds.length === 0,
    `accessibility blockers remain in ${result?.scenario ?? "unknown scenario"}`);
  }

  requireEvidence(Array.isArray(report.screenshots) && report.screenshots.length >= 13,
    "screenshots are incomplete");
  const screenshotNames = new Set();
  for (const screenshot of report.screenshots) {
    requireEvidence(object(screenshot) && typeof screenshot.path === "string"
      && screenshot.path.startsWith("evidence/") && screenshot.path.endsWith(".png"),
    "screenshot path is invalid");
    requireEvidence(!screenshotNames.has(screenshot.path),
      `duplicate screenshot ${screenshot.path}`);
    screenshotNames.add(screenshot.path);
    requireEvidence(Number.isSafeInteger(screenshot.byteLength) && screenshot.byteLength > 0,
      `screenshot is empty: ${screenshot.path}`);
    requireEvidence(SHA256.test(screenshot.sha256),
      `screenshot hash is invalid: ${screenshot.path}`);
  }
  for (const path of [
    "evidence/release-a-import-review-desktop.png",
    "evidence/release-a-import-published-desktop.png",
    "evidence/release-a-import-undo-desktop.png",
  ]) requireEvidence(screenshotNames.has(path), `required screenshot is missing: ${path}`);

  requireEvidence(Array.isArray(report.unexpectedConsoleErrors)
    && report.unexpectedConsoleErrors.length === 0, "unexpected console errors remain");
  requireEvidence(Array.isArray(report.unexpectedPageErrors)
    && report.unexpectedPageErrors.length === 0, "unexpected page errors remain");
  requireEvidence(Array.isArray(report.externalRequests)
    && report.externalRequests.length === 0, "external requests remain");
  return report;
}
