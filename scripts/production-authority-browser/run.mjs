import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const fixtureDir = new URL("./", import.meta.url);
const outDir = new URL("../../evidence/production-authority-browser/", import.meta.url);
const port = Number.parseInt(process.env.PORT || "4177", 10);
let server = null;
let serverOutput = "";
let url = process.env.URL;

if (!url) {
  const vite = fileURLToPath(new URL(
    "../../packages/shell/node_modules/vite/bin/vite.js", import.meta.url,
  ));
  server = spawn(process.execPath, [vite, fileURLToPath(fixtureDir),
    "--config", fileURLToPath(new URL("vite.config.mjs", fixtureDir)),
    "--configLoader", "runner", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", chunk => { serverOutput += String(chunk); });
  server.stderr.on("data", chunk => { serverOutput += String(chunk); });
  url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) break;
    try { if ((await fetch(url)).ok) { ready = true; break; } } catch { /* wait */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`authority evidence server did not start: ${serverOutput}`);
}
process.on("exit", () => { try { server?.kill(); } catch { /* stopped */ } });

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", error => errors.push(error.message));
await page.goto(url, { waitUntil: "domcontentloaded" });
const invoke = payload => page.evaluate(input => window.authorityRun(input), payload);
const failures = [];

await invoke({ op: "reset" });
const seeded = await invoke({ op: "seed" });
if (seeded.state !== "complete" || seeded.catalogPresent || seeded.namespaces.length !== 2)
  failures.push(`legacy fixture inventory mismatch: ${JSON.stringify(seeded)}`);
const partial = await invoke({ op: "partial" });
if (partial.remaining !== 1 || partial.entries !== 1 || partial.selectedStorageKey === "field")
  failures.push(`partial bootstrap mismatch: ${JSON.stringify(partial)}`);
const resumed = await invoke({ op: "boot", requestedAppId: "field" });
if (resumed.boot.apps.length !== 2
    || resumed.boot.apps.find(app => app.id === resumed.boot.selectedAppInstanceId)?.name !== "Field Service"
    || resumed.rows.length !== 1 || resumed.rows[0]?.name !== "Field row")
  failures.push(`resumed selected target mismatch: ${JSON.stringify(resumed)}`);
const projects = resumed.boot.apps.find(app => app.name === "Projects");
if (!projects) failures.push("canonical Projects app is missing");
let switched = null;
if (projects) {
  switched = await invoke({ op: "boot", requestedAppId: projects.id });
  if (switched.boot.selectedAppInstanceId !== projects.id
      || switched.rows.length !== 1 || switched.rows[0]?.name !== "Projects row")
    failures.push(`catalog switch mismatch: ${JSON.stringify(switched)}`);
}
const final = await invoke({ op: "inspect" });
if (final.manifest.length !== 0 || final.catalog.entries.length !== 2
    || final.activeStorage.length !== 2 || final.inventory.namespaces.length !== 2)
  failures.push(`final inventory mismatch: ${JSON.stringify(final)}`);

const hash = async file => createHash("sha256").update(await readFile(file)).digest("hex");
const sources = {
  runner: new URL("run.mjs", fixtureDir),
  controller: new URL("index.html", fixtureDir),
  viteConfig: new URL("vite.config.mjs", fixtureDir),
  worker: new URL("worker.ts", fixtureDir),
  authority: new URL("../../packages/kernel/src/production-authority.ts", fixtureDir),
  catalog: new URL("../../packages/kernel/src/device-catalog.ts", fixtureDir),
};
const sourceSha256 = Object.fromEntries(await Promise.all(Object.entries(sources)
  .map(async ([name, file]) => [name, await hash(file)])));
const valid = failures.length === 0 && errors.length === 0;
const report = {
  schema: 1,
  verdict: valid ? "PRODUCTION_BOOT_SLICE_VALIDATED" : "INVALIDATED",
  releaseCertificate: false,
  browser: await browser.version(),
  sourceSha256,
  cases: {
    twoLegacyNamespaces: true,
    interruptedAfterOneAtomicAdoption: true,
    freshWorkerResume: true,
    catalogCanonicalSwitch: true,
  },
  seeded,
  partial,
  resumed,
  switched,
  final,
  failures,
  consoleErrors: errors,
  limitations: [
    "Chromium OPFS only; other durable runtimes remain uncertified.",
    "The interruption is between committed adoption transactions, not during native SQLite COMMIT.",
    "This certifies catalog-first boot/adoption/switch only, not complete production write routing or Release B.",
  ],
};
await writeFile(new URL("report.json", outDir), JSON.stringify(report, null, 2));
await browser.close();
if (server) server.kill();
console.log(JSON.stringify({
  verdict: report.verdict,
  releaseCertificate: report.releaseCertificate,
  failures: report.failures,
  consoleErrors: report.consoleErrors,
  report: "evidence/production-authority-browser/report.json",
}));
if (!valid) process.exit(1);
