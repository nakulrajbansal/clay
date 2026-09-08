import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const fixtureDir = new URL("./", import.meta.url);
const outDir = new URL("../../evidence/release-c-parser/", import.meta.url);
const port = Number.parseInt(process.env.PORT || "4189", 10);
const localOrigin = `http://127.0.0.1:${port}`;
let server = null;
let serverOutput = "";
let browser = null;

try {
  const vite = fileURLToPath(new URL(
    "../../packages/shell/node_modules/vite/bin/vite.js",
    import.meta.url,
  ));
  server = spawn(process.execPath, [
    vite,
    fileURLToPath(fixtureDir),
    "--config",
    fileURLToPath(new URL("vite.config.mjs", fixtureDir)),
    "--configLoader",
    "runner",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", chunk => { serverOutput += String(chunk); });
  server.stderr.on("data", chunk => { serverOutput += String(chunk); });

  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) break;
    try {
      if ((await fetch(localOrigin)).ok) { ready = true; break; }
    } catch {
      // Wait for Vite to bind its local-only port.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`Release C parser server did not start: ${serverOutput}`);

  browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors = [];
  const externalRequests = [];
  page.on("console", message => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", error => { consoleErrors.push(error.message); });
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.origin !== localOrigin) externalRequests.push(request.url());
  });
  await page.goto(localOrigin, { waitUntil: "networkidle" });

  const csv = await page.evaluate(input => window.releaseCParserRun(input), {
    kind: "csv",
    text: "Name,Payload\r\nformula,=1+1\r\nhtml,<script>globalThis.pwned=true</script>\r\nquoted,\"a,b\"",
  });
  const paste = await page.evaluate(input => window.releaseCParserRun(input), {
    kind: "paste",
    text: "Name\tStatus\nAlpha\tOpen\nBeta\tDone",
  });
  const browserState = await page.evaluate(async () => ({
    pwned: Object.hasOwn(globalThis, "pwned"),
    localStorage: localStorage.length,
    sessionStorage: sessionStorage.length,
    caches: "caches" in globalThis ? (await caches.keys()).length : 0,
    indexedDatabases: typeof indexedDB.databases === "function"
      ? (await indexedDB.databases()).length
      : 0,
  }));

  const expectedCsv = [
    ["Name", "Payload"],
    ["formula", "=1+1"],
    ["html", "<script>globalThis.pwned=true</script>"],
    ["quoted", "a,b"],
  ];
  const expectedPaste = [
    ["Name", "Status"],
    ["Alpha", "Open"],
    ["Beta", "Done"],
  ];
  const assertions = {
    csvExact: JSON.stringify(csv.rows) === JSON.stringify(expectedCsv),
    pasteExact: JSON.stringify(paste.rows) === JSON.stringify(expectedPaste),
    formulasAndHtmlInert: browserState.pwned === false,
    sessionsDisposed: csv.disposed === true && paste.disposed === true,
    sourceKindsExact: csv.descriptor.kind === "csv" && paste.descriptor.kind === "paste",
    sourceDigestsBound: /^sha256:[0-9a-f]{64}$/.test(csv.descriptor.sourceDigest)
      && /^sha256:[0-9a-f]{64}$/.test(paste.descriptor.sourceDigest)
      && csv.descriptor.sourceDigest !== paste.descriptor.sourceDigest,
    noPersistentBrowserState: browserState.localStorage === 0
      && browserState.sessionStorage === 0
      && browserState.caches === 0
      && browserState.indexedDatabases === 0,
    localOriginOnly: externalRequests.length === 0,
    noConsoleErrors: consoleErrors.length === 0,
  };
  const failures = Object.entries(assertions)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);

  const hash = async file => createHash("sha256").update(await readFile(file)).digest("hex");
  const sources = {
    runner: new URL("run.mjs", fixtureDir),
    controller: new URL("index.html", fixtureDir),
    main: new URL("main.ts", fixtureDir),
    viteConfig: new URL("vite.config.mjs", fixtureDir),
    worker: new URL("../../packages/shell/src/worker/release-c/import-worker.ts", fixtureDir),
    workerRuntime: new URL("../../packages/shell/src/worker/release-c/import-worker-runtime.ts", fixtureDir),
    workerClient: new URL("../../packages/shell/src/worker/release-c/import-worker-client.ts", fixtureDir),
    csvParser: new URL("../../packages/shell/src/worker/release-c/csv-parser.ts", fixtureDir),
    sessions: new URL("../../packages/shell/src/worker/release-c/parser-session.ts", fixtureDir),
    contracts: new URL("../../packages/kernel/src/import-contracts.ts", fixtureDir),
    grammar: new URL("../../packages/kernel/src/import-grammar.ts", fixtureDir),
    lockfile: new URL("../../pnpm-lock.yaml", fixtureDir),
  };
  const sourceSha256 = Object.fromEntries(await Promise.all(Object.entries(sources)
    .map(async ([name, file]) => [name, await hash(file)])));
  const valid = failures.length === 0;
  const report = {
    schema: 1,
    verdict: valid ? "RELEASE_C_PARSER_FOUNDATION_VALIDATED" : "INVALIDATED",
    releaseCertificate: false,
    shippingEnabled: false,
    browser: await browser.version(),
    sourceSha256,
    assertions,
    csv,
    paste,
    browserState,
    externalRequests,
    consoleErrors,
    failures,
    limitations: [
      "This validates the local CSV/paste parser foundation only.",
      "The production import entrypoint remains disabled.",
      "XLSX remains unavailable until a separately reviewed parser is approved.",
      "This does not certify migration writes, backup preconditions, or Release C.",
    ],
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(new URL("report.json", outDir), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    verdict: report.verdict,
    releaseCertificate: report.releaseCertificate,
    shippingEnabled: report.shippingEnabled,
    failures,
    report: "evidence/release-c-parser/report.json",
  }));
  if (!valid) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
