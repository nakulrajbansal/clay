import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const fixtureDir = new URL("./", import.meta.url);
const outDir = new URL("../../evidence/transaction-certificate/", import.meta.url);
const port = Number.parseInt(process.env.PORT || "4176", 10);
const roundsText = process.env.ROUNDS || "20";
if (!/^[1-9][0-9]*$/.test(roundsText) || Number(roundsText) > 100)
  throw new Error("ROUNDS must be a whole number from 1 through 100");
const rounds = Number(roundsText);
let serverProcess = null;
let serverOutput = "";
let url = process.env.URL;

if (!url) {
  const viteCli = fileURLToPath(new URL(
    "../../packages/shell/node_modules/vite/bin/vite.js", import.meta.url,
  ));
  serverProcess = spawn(process.execPath, [viteCli, fileURLToPath(fixtureDir),
    "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  serverProcess.stdout.on("data", chunk => { serverOutput += String(chunk); });
  serverProcess.stderr.on("data", chunk => { serverOutput += String(chunk); });
  url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (serverProcess.exitCode !== null) break;
    try { if ((await fetch(url)).ok) { ready = true; break; } } catch { /* wait */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`certificate server did not start: ${serverOutput}`);
}
process.on("exit", () => { try { serverProcess?.kill(); } catch { /* already stopped */ } });

const REQUIRED_CRASH_FAILPOINTS = Object.freeze([
  "after_begin", "after_schema_create", "after_schema_insert", "after_main",
  "after_system", "after_catalog", "before_commit", "after_commit",
]);
const CASES_PER_ROUND = 9;
const EXPECTED_SQLITE_SOURCE_HASH = "4525003a53a7fc63ca75c59b22c79608659ca12f0131f52c18637f829977f20b";
const failpoints = [...REQUIRED_CRASH_FAILPOINTS, null];
if (failpoints.length !== CASES_PER_ROUND) throw new Error("fault registry is incomplete");
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const consoleErrors = [];
page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("pageerror", error => consoleErrors.push(error.message));
await page.goto(url, { waitUntil: "domcontentloaded" });

const invoke = payload => page.evaluate(input => window.certRun(input), payload);
const retry = async (payload, attempts = 20) => {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await invoke(payload); }
    catch (error) {
      lastError = error;
      await page.waitForTimeout(100 + attempt * 25);
    }
  }
  throw lastError;
};
const values = result => [result.main, result.system, result.catalog];
const failures = [];
const cases = [];
let metadata = null;

for (let round = 0; round < rounds; round++) {
  for (const failpoint of failpoints) {
    const name = failpoint ?? "normal";
    const oldValue = `old-${round}-${name}`;
    const newValue = `new-${round}-${name}`;
    await retry({ op: "reset", value: oldValue });
    const before = (await retry({ op: "read" })).value;
    if (!values(before).every(value => value === oldValue))
      failures.push(`${round}/${name}: baseline mismatch ${JSON.stringify(values(before))}`);
    const outcome = await retry({ op: "mutate", value: newValue, failpoint });
    if (failpoint && (outcome.kind !== "terminated" || outcome.point !== failpoint))
      failures.push(`${round}/${name}: expected termination at ${failpoint}, got ${JSON.stringify(outcome)}`);
    if (!failpoint && outcome.kind !== "result")
      failures.push(`${round}/${name}: normal commit did not return`);
    await page.waitForTimeout(75);
    const after = (await retry({ op: "read" })).value;
    if (!metadata) {
      metadata = {
        browser: await browser.version(), sqliteSourceId: after.sqliteSourceId,
        journalMode: after.journalMode, vfs: "clay-cert-sahpool", databases: 3,
      };
      if (!after.sqliteSourceId.endsWith(EXPECTED_SQLITE_SOURCE_HASH))
        failures.push(`unexpected SQLite source: ${after.sqliteSourceId}`);
      if (!after.journalMode.every(mode => mode === "delete"))
        failures.push(`unexpected journal modes: ${JSON.stringify(after.journalMode)}`);
    }
    const committed = failpoint === "after_commit" || failpoint === null;
    const expected = committed ? newValue : oldValue;
    const observed = values(after);
    const shapeAtomic = committed
      ? after.shapeExists === 1 && after.shapeValue === newValue
      : after.shapeExists === 0 && after.shapeValue === null;
    const atomic = observed.every(value => value === expected) && shapeAtomic;
    const integral = after.integrity.every(value => value === "ok");
    if (!atomic) failures.push(`${round}/${name}: expected ${expected}, got ${JSON.stringify({ observed, shapeExists: after.shapeExists, shapeValue: after.shapeValue })}`);
    if (!integral) failures.push(`${round}/${name}: integrity ${JSON.stringify(after.integrity)}`);
    cases.push({ round, failpoint: name, expected, observed,
      shapeExists: after.shapeExists, shapeValue: after.shapeValue, atomic, integral });
  }
}

const hashFile = async file => createHash("sha256").update(await readFile(file)).digest("hex");
const sourceFiles = {
  runner: new URL("run.mjs", fixtureDir),
  controller: new URL("index.html", fixtureDir),
  worker: new URL("worker.ts", fixtureDir),
  lockfile: new URL("../../pnpm-lock.yaml", fixtureDir),
  sqliteWasm: new URL("../../packages/kernel/node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm", fixtureDir),
};
const sourceSha256 = Object.fromEntries(await Promise.all(Object.entries(sourceFiles)
  .map(async ([name, file]) => [name, await hashFile(file)])));
const passed = cases.filter(item => item.atomic && item.integral).length;
const expectedTotal = rounds * CASES_PER_ROUND;
const coverage = new Set(cases.map(item => `${item.round}/${item.failpoint}`));
const coverageComplete = cases.length === expectedTotal && coverage.size === expectedTotal;
const valid = failures.length === 0 && consoleErrors.length === 0
  && passed === expectedTotal && coverageComplete;
const report = {
  schema: 1,
  verdict: valid ? "CORE_MECHANISM_VALIDATED" : "INVALIDATED",
  releaseCertificate: false,
  question: "Do three attached SQLite-WASM SAH-pool databases recover atomically after worker termination between SQL statements?",
  rounds, failpoints: failpoints.map(value => value ?? "normal"), metadata, sourceSha256,
  limitations: [
    "Chromium only; every release-supported durable runtime still needs this matrix.",
    "Termination is between SQL statements, not an operating-system power loss during native COMMIT.",
    "DDL, row, metadata, and catalog surrogates are covered; production cursors, receipts, and selected pointers still need registered semantic hooks and concurrency oracles.",
  ],
  passed, total: cases.length, expectedTotal, coverageComplete, failures, consoleErrors, cases,
};
await writeFile(new URL("report.json", outDir), JSON.stringify(report, null, 2));
await browser.close();
if (serverProcess) serverProcess.kill();
console.log(JSON.stringify({
  schema: report.schema, verdict: report.verdict, releaseCertificate: report.releaseCertificate,
  rounds: report.rounds, passed: report.passed, total: report.total,
  expectedTotal: report.expectedTotal, coverageComplete: report.coverageComplete,
  failures: report.failures, consoleErrors: report.consoleErrors,
  browser: report.metadata?.browser, sqliteSourceId: report.metadata?.sqliteSourceId,
  report: "evidence/transaction-certificate/report.json",
}));
if (!valid) process.exit(1);
