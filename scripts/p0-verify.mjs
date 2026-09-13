// One source-bound, serial P0 checkpoint. No installation, git writes, or external browser attachment.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotBuildInputs, fingerprint } from "./p0-source-binding.mjs";
import { rejectExternalBrowser } from "./p0-browser-safety.mjs";
import { collectReviewFiles, scanReviewSource } from "./p0-review-evidence.mjs";

rejectExternalBrowser(process.env);
const root = fileURLToPath(new URL("../", import.meta.url));
if (process.platform === "win32" && resolve(root).toLowerCase() !== "d:\\clay")
  throw new Error("P0 verification must run only in D:\\Clay");
const git = args => execFileSync("git", args, { cwd: root, windowsHide: true, encoding: "utf8" }).trim();
if (git(["branch", "--show-current"]) !== "codex/clay-project") throw new Error("wrong P0 review branch");
const baseHead = git(["rev-parse", "HEAD"]);
const inputs = await snapshotBuildInputs(root);
const sourceFingerprint = fingerprint(inputs);
const directory = join(root, "evidence", "p0-verification");
await mkdir(directory, { recursive: true });
const gates = [];
async function run(name, cwd, args, executable = process.execPath) {
  const started = Date.now();
  const command = [executable, ...args];
  console.log(`\nGATE ${name}: ${command.join(" ")} (cwd ${cwd})`);
  let output = "";
  const exitCode = await new Promise(resolveExit => {
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const consume = bytes => { output += bytes; process.stdout.write(bytes); };
    child.stdout.on("data", consume); child.stderr.on("data", consume);
    child.on("error", error => { output += `\nLaunch failed: ${error.message}\n`; resolveExit(-1); });
    child.on("close", code => resolveExit(code ?? -1));
  });
  const log = `evidence/p0-verification/${name}.log`;
  await writeFile(join(root, log), output);
  const gate = { name, command, cwd, exitCode, passed: exitCode === 0,
    durationMs: Date.now() - started, log };
  gates.push(gate);
  return gate;
}
const packet = files => ["node_modules/vitest/vitest.mjs", "run", ...files,
  "--maxWorkers=1", "--minWorkers=1", "--reporter=dot"];
await run("harness-security", root, ["--test", "scripts/p0-browser-safety.test.mjs", "scripts/p0-source-binding.test.mjs",
  "scripts/p0-review-evidence.test.mjs",
  "scripts/bundle-budget.test.mjs", "scripts/product-gate-config.test.mjs", "scripts/share-routing-config.test.mjs", "scripts/release-a-evidence.test.mjs"]);
await run("focused-kernel", join(root, "packages/kernel"), packet(["test/app-lifecycle.test.ts", "test/lifecycle-recovery-inventory.test.ts", "test/archive-authority.test.ts"]));
await run("focused-shell", join(root, "packages/shell"), packet(["test/worker-lifecycle-integration.test.ts",
  "test/app-setup-intent.test.ts", "test/new-app-import.test.ts", "test/app-first-run-import-confirmation.test.tsx"]));
for (const name of ["schema", "kernel", "shell"])
  await run(`typecheck-${name}`, join(root, "packages", name), ["node_modules/typescript/bin/tsc", "--noEmit"]);
for (const name of ["schema", "kernel", "shell"])
  await run(`suite-${name}`, join(root, "packages", name), packet([]));
await run("packaged-browser", root, ["scripts/p0-multi-app-ui.mjs"]);
await run("frozen-budget", root, ["scripts/bundle-budget.mjs"]);
await run("complete-bundle-measurements", root, ["scripts/p0-bundle-report.mjs"]);
await run("diff-check", root, ["diff", "--check"], "git");

const endingSourceFingerprint = fingerprint(await snapshotBuildInputs(root));
const browserReport = JSON.parse(await readFile(join(root, "evidence/p0-multi-app-ui/report.json"), "utf8"));
const routes = (await import("../packages/shell/src/worker/mutation-route-census.ts")).DB_WORKER_ROUTE_CENSUS;
const journeys = [
  ["Create blank/starter", ["createApp", "seed"], "App.tsx / Onboarding"],
  ["Switch and reload isolation", ["switchApp"], "AppSwitcher.tsx"],
  ["Rename", ["renameApp"], "AppSwitcher.tsx"],
  ["Independent duplicate/history/panels", ["forkApp"], "AppSwitcher.tsx"],
  ["Confirmed delete/fallback/last-app denial", ["deleteApp"], "AppSwitcher.tsx"],
  ["Spreadsheet Preview/Keep/Discard/Undo", ["importNewApp", "undoNewAppImport"], "ImportReview.tsx / App.tsx"],
  ["Legacy OPFS adoption and crash recovery", ["boot"], "worker boot"],
].map(([journey, operations, ui]) => ({ journey, sourceAncestry: { baseHead, uncommittedReviewSource: sourceFingerprint },
  productionRoutes: operations.map(op => ({ op, ...routes[op] })), ui,
  focusedEvidence: ["focused-kernel.log", "focused-shell.log"],
  packagedEvidence: "evidence/p0-multi-app-ui/report.json", status: "partial",
  reason: "Uncommitted review candidate; packaged proof and frozen release gates are required." }));

const changedPaths = () => [...new Set([...git(["diff", "--name-only"]).split(/\r?\n/),
  ...git(["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/)])].filter(Boolean).sort();
const scan = [];
for (const path of changedPaths()) {
  if (!/\.(?:ts|tsx|mjs|json|md)$/.test(path) || path.startsWith("evidence/")) continue;
  if (/(?:^|\/)(?:\.env|credentials|secrets)(?:[./]|$)/i.test(path)) throw new Error("sensitive file must not enter review evidence");
  const source = await readFile(join(root, path), "utf8");
  scan.push(...scanReviewSource(path, source));
}
const sourceStable = sourceFingerprint === endingSourceFingerprint;
const report = { schema: 1, generatedAt: new Date().toISOString(), baseHead, sourceFingerprint, endingSourceFingerprint,
  sourceStable, gates, journeys, scanFindings: scan,
  verdict: sourceStable && gates.every(gate => gate.passed) && scan.length === 0
    ? "AUTOMATED_GATES_PASSED_REVIEW_PENDING" : "INVALIDATED", releaseCertificate: false,
  browserStatus: browserReport.status ?? browserReport.verdict,
  limitations: ["The working tree is intentionally uncommitted; no git writes were attempted.",
    "Automated scan findings require contextual review; absence of matches is not security certification.",
    "Independent security/product review, packaged browser proof, frozen budgets, and manual NVDA certification are not inferred from unit tests."] };
await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));

const files = await collectReviewFiles(root, changedPaths());
const reviewFingerprint = createHash("sha256").update(Object.entries(files).map(([path, hash]) => `${path}\0${hash}`).join("\n")).digest("hex");
await writeFile(join(directory, "review.json"), JSON.stringify({ schema: 1, baseHead, sourceFingerprint,
  reviewFingerprint, algorithm: "SHA-256 of sorted path + NUL + lowercase file SHA-256, newline-separated; this manifest alone is excluded",
  files }, null, 2));
console.log(JSON.stringify({ verdict: report.verdict, sourceStable, reviewFingerprint,
  changedFiles: Object.keys(files).length, gates: gates.map(({ name, exitCode }) => ({ name, exitCode })),
  scanFindings: scan, report: "evidence/p0-verification/report.json", review: "evidence/p0-verification/review.json" }));
if (!sourceStable || gates.some(gate => !gate.passed) || scan.length) process.exitCode = 1;
