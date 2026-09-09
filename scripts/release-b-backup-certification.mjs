import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { productGateUrl } from "./product-gate-url.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const shellRoot = resolve(repositoryRoot, "packages/shell");
const requireFromShell = createRequire(join(shellRoot, "package.json"));
const { chromium } = requireFromShell("playwright");
const { createServer } = await import(pathToFileURL(requireFromShell.resolve("vite")).href);
const profile = await mkdtemp(join(tmpdir(), "clay-release-b-restart-"));
const html = "<!doctype html><html><body><button id=go>authorize</button></body></html>";
const url = productGateUrl();
const gateUrl = new URL(url);
const server = await createServer({
  root: shellRoot,
  configFile: false,
  appType: "custom",
  logLevel: "error",
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
await server.listen();
const sourceAddress = server.httpServer.address();
if (!sourceAddress || typeof sourceAddress === "string")
  throw new Error("Release B source server address is unavailable");
const sourceOrigin = `http://127.0.0.1:${sourceAddress.port}`;

const fileOne = `clay-release-b-restart-20260908T120000000Z-backupgen_${"a".repeat(26)}.clay`;
const fileTwo = `clay-release-b-restart-20260908T120000001Z-backupgen_${"b".repeat(26)}.clay`;
const appId = `app_${"c".repeat(26)}`;
const certifiedBrowserVersion = "149.0.7827.55";
const firstBytes = Uint8Array.from([1, 3, 3, 7, 9]);
const secondBytes = Uint8Array.from([2, 4, 6, 8, 10, 12]);
const productionSourcePath = resolve(shellRoot, "src/app/production-backup.browser.ts");
const targetSourcePath = resolve(shellRoot, "src/app/backup-target.browser.ts");
const externalBackupPath = resolve(repositoryRoot, "packages/kernel/src/external-backup.ts");
const certificationEvidencePath = resolve(
  shellRoot,
  "src/app/backup-adapter-certification-evidence.json",
);
const restartSuitePaths = [
  ["packages/shell/test/backup-target.browser.test.ts", resolve(shellRoot, "test/backup-target.browser.test.ts")],
  ["packages/shell/test/production-backup.browser.test.ts", resolve(shellRoot, "test/production-backup.browser.test.ts")],
  [
    "packages/kernel/test/external-backup-memory.gate.test.ts",
    resolve(repositoryRoot, "packages/kernel/test/external-backup-memory.gate.test.ts"),
  ],
];

function sha256(data) {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

function hashNamedFiles(entries) {
  const hash = createHash("sha256");
  for (const [name, bytes] of entries) {
    hash.update(name);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function sourceSha(source, field) {
  const match = source.match(new RegExp(`${field}:\\s*"(sha256:[0-9a-f]{64})"`));
  if (!match) throw new Error(`production ${field} binding is missing`);
  return match[1];
}

async function calculateArtifactBinding() {
  const [targetBytes, productionBytes, externalBytes, matrixBytes, ...suiteBytes] =
    await Promise.all([
      readFile(targetSourcePath),
      readFile(productionSourcePath),
      readFile(externalBackupPath),
      readFile(fileURLToPath(import.meta.url)),
      ...restartSuitePaths.map(([, path]) => readFile(path)),
    ]);
  const productionSource = productionBytes.toString("utf8");
  const normalizedBuild = productionSource.replace(
    /(buildSha256:\s*"sha256:)[0-9a-f]{64}("),/,
    `$1${"0".repeat(64)}$2,`,
  );
  const normalizedProduction = normalizedBuild.replace(
    /(evidenceSha256:\s*\n?\s*"sha256:)[0-9a-f]{64}("),/,
    `$1${"0".repeat(64)}$2,`,
  );
  if (normalizedBuild === productionSource || normalizedProduction === normalizedBuild)
    throw new Error("production build binding could not be normalized");
  const calculated = {
    codeSha256: sha256(targetBytes),
    buildSha256: hashNamedFiles([
      ["packages/shell/src/app/production-backup.browser.ts", Buffer.from(normalizedProduction)],
      ["packages/kernel/src/external-backup.ts", externalBytes],
    ]),
    matrixSha256: sha256(matrixBytes),
    suiteSha256: hashNamedFiles(
      restartSuitePaths.map(([name], index) => [name, suiteBytes[index]]),
    ),
  };
  for (const [field, digest] of Object.entries(calculated)) {
    if (sourceSha(productionSource, field) !== digest)
      throw new Error(`${field} does not bind the current Release B artifact`);
  }
  if (!/runtimeVersion:\s*"149\.0\.7827\.55"/.test(productionSource))
    throw new Error("production runtime binding is not the certified Chromium patch");
  return { ...calculated, productionSource };
}

function calculateEvidenceSha(binding, firstSha256, secondSha256) {
  return sha256(Buffer.from(JSON.stringify({
    runtime: "chromium-149.0.7827.55-windows-x64",
    codeSha256: binding.codeSha256,
    buildSha256: binding.buildSha256,
    matrixSha256: binding.matrixSha256,
    suiteSha256: binding.suiteSha256,
    firstProcessWriteSha256: firstSha256,
    fullProcessExitObserved: true,
    freshProcessReacquiredWithoutPicker: true,
    permissionRechecked: true,
    firstFileReadBackSha256: firstSha256,
    secondUniqueFileReadBackSha256: secondSha256,
    enumerationObservedBoth: true,
    ownedProbeCleanupVerified: true,
  })));
}

function objectRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} evidence is malformed`);
  return value;
}

async function verifyCheckedInEvidence(
  binding,
  firstSha256,
  secondSha256,
  evidenceSha256,
  observedRuntime,
) {
  let decoded;
  try {
    decoded = JSON.parse(await readFile(certificationEvidencePath, "utf8"));
  } catch (error) {
    throw new Error(`checked-in certification evidence is unreadable: ${String(error)}`);
  }
  const evidence = objectRecord(decoded, "certification");
  const artifact = objectRecord(evidence.artifactBinding, "artifact binding");
  const runtime = objectRecord(evidence.runtime, "runtime");
  const userAgentData = objectRecord(runtime.userAgentData, "runtime UA-CH");
  const restart = objectRecord(evidence.restartProbe, "restart probe");
  const memory = objectRecord(evidence.memoryGate, "memory gate");
  const expectedArtifact = {
    codeSha256: binding.codeSha256,
    buildSha256: binding.buildSha256,
    matrixSha256: binding.matrixSha256,
    suiteSha256: binding.suiteSha256,
  };
  for (const [field, digest] of Object.entries(expectedArtifact)) {
    if (artifact[field] !== digest)
      throw new Error(`checked-in evidence ${field} does not match the current artifact`);
  }
  if (evidence.schema !== 1
      || evidence.certification !== "release-b-browser-directory-v1"
      || evidence.certificationId !== "btc_4w6xbvamg5bdmccgp5kwlwg4pi"
      || runtime.osFamily !== "windows"
      || runtime.runtimeFamily !== "chromium"
      || runtime.runtimeVersion !== certifiedBrowserVersion
      || runtime.architecture !== "x64"
      || runtime.userAgent !== observedRuntime.userAgent
      || JSON.stringify(userAgentData) !== JSON.stringify(observedRuntime.userAgentData)
      || runtime.arrayBufferTransfer !== true)
    throw new Error("checked-in runtime evidence is not the certified runtime");
  if (!Number.isSafeInteger(restart.firstProcessPid) || restart.firstProcessPid <= 0
      || !Number.isSafeInteger(restart.secondProcessPid) || restart.secondProcessPid <= 0
      || restart.firstProcessPid === restart.secondProcessPid
      || restart.fullProcessExitObserved !== true
      || restart.distinctProcessObserved !== true
      || restart.firstProcessPickerCalls !== 1
      || restart.freshProcessPickerCalls !== 0
      || restart.freshProcessReacquiredWithoutPicker !== true
      || !Number.isSafeInteger(restart.firstProcessPermissionQueries)
      || restart.firstProcessPermissionQueries < 1
      || !Number.isSafeInteger(restart.freshProcessPermissionQueries)
      || restart.freshProcessPermissionQueries < 1
      || restart.permissionRechecked !== true
      || restart.firstProcessWriteSha256 !== firstSha256
      || restart.firstFileReadBackSha256 !== firstSha256
      || restart.secondUniqueFileReadBackSha256 !== secondSha256
      || restart.enumerationObservedBoth !== true
      || restart.ownedProbeCleanupVerified !== true
      || restart.evidenceSha256 !== evidenceSha256
      || !Array.isArray(restart.browserErrors)
      || restart.browserErrors.length !== 0)
    throw new Error("checked-in restart evidence is incomplete or divergent");
  const archiveBytes = 384 * 1024 * 1024;
  if (memory.command !== "pnpm verify:release-b-backup"
      || memory.archiveBytes !== archiveBytes
      || memory.sourceBytes !== archiveBytes
      || memory.sourceDetachedBeforeRead !== true
      || memory.result !== "pass"
      || !Number.isSafeInteger(memory.measuredPeak)
      || !Number.isSafeInteger(memory.maximumAllowedPeak)
      || memory.maximumAllowedPeak !== archiveBytes + 8 * 1024 * 1024
      || memory.measuredPeak > memory.maximumAllowedPeak)
    throw new Error("checked-in memory evidence is incomplete or divergent");
  return evidence;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function waitForExit(pid) {
  for (let attempt = 0; attempt < 100 && alive(pid); attempt++)
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  if (alive(pid)) throw new Error(`Chromium process ${pid} did not fully exit`);
}
async function browserPid(browser) {
  const session = await browser.newBrowserCDPSession();
  try {
    const info = await session.send("SystemInfo.getProcessInfo");
    const found = info.processInfo.find(entry => entry.type === "browser");
    if (!found || !Number.isSafeInteger(Number(found.id))) throw new Error("browser PID unavailable");
    return Number(found.id);
  } finally {
    await session.detach();
  }
}

async function installProbe(page, mode) {
  await page.evaluate(async ({ modeValue, appIdValue, fileOneValue, fileTwoValue, first, second }) => {
    const root = await navigator.storage.getDirectory();
    const prototype = Object.getPrototypeOf(root);
    const originalQuery = prototype.queryPermission;
    let permissionQueries = 0;
    Object.defineProperty(prototype, "queryPermission", {
      configurable: true,
      value: async function(descriptor) {
        permissionQueries++;
        if (descriptor?.mode !== "readwrite") throw new Error("non-readwrite permission probe");
        return Reflect.apply(originalQuery, this, [descriptor]);
      },
    });
    let pickerCalls = 0;
    Object.defineProperty(globalThis, "showDirectoryPicker", {
      configurable: true,
      value: async () => {
        pickerCalls++;
        if (modeValue !== "first") throw new Error("fresh process reopened the picker");
        return navigator.storage.getDirectory();
      },
    });
    const module = await import("/src/app/production-backup.browser.ts");
    const sha256 = async bytes => {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      return `sha256:${[...digest].map(value => value.toString(16).padStart(2, "0")).join("")}`;
    };
    const enumerate = async () => {
      const names = [];
      for await (const [name] of root.entries()) names.push(name);
      return names.sort();
    };
    const run = async () => {
      const adapter = module.createProductionBackupAdapter(
        indexedDB,
        undefined,
        undefined,
        () => "2026-09-08T12:30:00.000Z",
      );
      if (!adapter) throw new Error("production adapter was not constructed");
      const availability = adapter.availability();
      if (availability.status !== "available")
        throw new Error(`production adapter unavailable: ${JSON.stringify(availability)}`);
      if (modeValue === "first") {
        const authorization = await adapter.authorizeFromUserGesture(appIdValue);
        if (authorization.status !== "authorized")
          throw new Error(`authorization failed: ${JSON.stringify(authorization)}`);
        localStorage.setItem("release-b-target", JSON.stringify(authorization.target));
        const directory = adapter.directory(authorization.target);
        const writer = await directory.createNew(fileOneValue);
        await writer.write(Uint8Array.from(first));
        await writer.close();
        const readBack = await directory.readExact(fileOneValue);
        return {
          target: authorization.target,
          pickerCalls,
          permissionQueries,
          readBackSha256: await sha256(readBack),
          names: await enumerate(),
          userAgent: navigator.userAgent,
          userAgentData: {
            platform: navigator.userAgentData?.platform ?? "",
            mobile: navigator.userAgentData?.mobile ?? true,
            brands: navigator.userAgentData?.brands.map(entry => ({ ...entry })) ?? [],
          },
        };
      }
      const target = JSON.parse(localStorage.getItem("release-b-target") ?? "null");
      const probe = await adapter.probe(target);
      if (probe.status !== "authorized") throw new Error(`reacquisition failed: ${JSON.stringify(probe)}`);
      const directory = adapter.directory(target);
      const firstReadBack = await directory.readExact(fileOneValue);
      const writer = await directory.createNew(fileTwoValue);
      await writer.write(Uint8Array.from(second));
      await writer.close();
      const secondReadBack = await directory.readExact(fileTwoValue);
      const namesBeforeCleanup = await enumerate();
      await directory.removeExact(fileOneValue);
      await directory.removeExact(fileTwoValue);
      const namesAfterCleanup = await enumerate();
      return {
        pickerCalls,
        permissionQueries,
        firstReadBackSha256: await sha256(firstReadBack),
        secondReadBackSha256: await sha256(secondReadBack),
        namesBeforeCleanup,
        namesAfterCleanup,
        userAgent: navigator.userAgent,
        userAgentData: {
          platform: navigator.userAgentData?.platform ?? "",
          mobile: navigator.userAgentData?.mobile ?? true,
          brands: navigator.userAgentData?.brands.map(entry => ({ ...entry })) ?? [],
        },
      };
    };
    if (modeValue === "first") {
      const button = document.querySelector("#go");
      globalThis.__releaseBPromise = new Promise((resolvePromise, rejectPromise) => {
        button.addEventListener("click", () => { void run().then(resolvePromise, rejectPromise); }, { once: true });
      });
    } else {
      globalThis.__releaseBPromise = run();
    }
  }, { modeValue: mode, appIdValue: appId, fileOneValue: fileOne, fileTwoValue: fileTwo, first: [...firstBytes], second: [...secondBytes] });
}

const browserErrors = [];
async function serveCertificationPage(page) {
  await page.route(`${gateUrl.origin}/**`, async route => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname === gateUrl.pathname && requestUrl.search === gateUrl.search) {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: html,
      });
      return;
    }
    const response = await route.fetch({
      url: `${sourceOrigin}${requestUrl.pathname}${requestUrl.search}`,
    });
    await route.fulfill({ response });
  });
}
async function navigate(page) {
  await serveCertificationPage(page);
  await page.goto(url);
}
function monitorPage(page, phase) {
  page.on("console", message => {
    if (message.type() === "error") browserErrors.push(`${phase}:console:${message.text()}`);
  });
  page.on("pageerror", error => { browserErrors.push(`${phase}:page:${error.message}`); });
}
let firstContext;
let secondContext;
try {
  firstContext = await chromium.launchPersistentContext(profile, { headless: true });
  const firstPage = firstContext.pages()[0] ?? await firstContext.newPage();
  monitorPage(firstPage, "first");
  await navigate(firstPage);
  await installProbe(firstPage, "first");
  await firstPage.locator("#go").click();
  const first = await firstPage.evaluate(() => globalThis.__releaseBPromise);
  const firstPid = await browserPid(firstContext.browser());
  const version = firstContext.browser().version();
  if (version !== certifiedBrowserVersion)
    throw new Error(`uncertified first Chromium version ${version}`);
  await firstContext.close();
  firstContext = undefined;
  await waitForExit(firstPid);

  secondContext = await chromium.launchPersistentContext(profile, { headless: true });
  const secondPage = secondContext.pages()[0] ?? await secondContext.newPage();
  monitorPage(secondPage, "second");
  await navigate(secondPage);
  await installProbe(secondPage, "second");
  const second = await secondPage.evaluate(() => globalThis.__releaseBPromise);
  const secondPid = await browserPid(secondContext.browser());
  const secondVersion = secondContext.browser().version();
  if (secondVersion !== certifiedBrowserVersion)
    throw new Error(`uncertified fresh Chromium version ${secondVersion}`);
  if (firstPid === secondPid) throw new Error("Chromium browser PID was reused across restart");
  if (first.userAgent !== second.userAgent
      || JSON.stringify(first.userAgentData) !== JSON.stringify(second.userAgentData))
    throw new Error("browser-reported runtime evidence diverged across restart");

  const expectedFirst = `sha256:${createHash("sha256").update(firstBytes).digest("hex")}`;
  const expectedSecond = `sha256:${createHash("sha256").update(secondBytes).digest("hex")}`;
  const artifactBinding = await calculateArtifactBinding();
  const evidenceSha256 = calculateEvidenceSha(artifactBinding, expectedFirst, expectedSecond);
  await verifyCheckedInEvidence(
    artifactBinding,
    expectedFirst,
    expectedSecond,
    evidenceSha256,
    { userAgent: second.userAgent, userAgentData: second.userAgentData },
  );
  const expectedCertificationDigests = {
    firstProcessWriteSha256: expectedFirst,
    firstFileReadBackSha256: expectedFirst,
    secondUniqueFileReadBackSha256: expectedSecond,
    evidenceSha256,
  };
  for (const [field, digest] of Object.entries(expectedCertificationDigests)) {
    if (sourceSha(artifactBinding.productionSource, field) !== digest)
      throw new Error(`${field} does not bind the observed restart evidence`);
  }
  if (first.pickerCalls !== 1 || second.pickerCalls !== 0)
    throw new Error(`picker count mismatch: ${first.pickerCalls}/${second.pickerCalls}`);
  if (first.readBackSha256 !== expectedFirst || second.firstReadBackSha256 !== expectedFirst
      || second.secondReadBackSha256 !== expectedSecond)
    throw new Error("restart read-back digest mismatch");
  if (!second.namesBeforeCleanup.includes(fileOne) || !second.namesBeforeCleanup.includes(fileTwo))
    throw new Error("fresh process did not enumerate both unique files");
  if (second.namesAfterCleanup.includes(fileOne) || second.namesAfterCleanup.includes(fileTwo))
    throw new Error("owned probe cleanup failed");
  if (first.permissionQueries < 1 || second.permissionQueries < 1)
    throw new Error("permission was not rechecked in both processes");
  if (browserErrors.length > 0)
    throw new Error(`browser errors: ${browserErrors.join(" | ")}`);

  console.log(JSON.stringify({
    status: "pass",
    runtime: {
      browser: "chromium",
      version,
      userAgent: second.userAgent,
      userAgentData: second.userAgentData,
    },
    firstProcess: { pid: firstPid, fullExitObserved: true, pickerCalls: first.pickerCalls, permissionQueries: first.permissionQueries },
    secondProcess: { pid: secondPid, distinctPid: true, pickerCalls: second.pickerCalls, permissionQueries: second.permissionQueries },
    artifactBinding: {
      codeSha256: artifactBinding.codeSha256,
      buildSha256: artifactBinding.buildSha256,
      matrixSha256: artifactBinding.matrixSha256,
      suiteSha256: artifactBinding.suiteSha256,
    },
    evidenceSha256,
    firstFileReadBackSha256: expectedFirst,
    secondUniqueFileReadBackSha256: expectedSecond,
    enumerationObservedBoth: true,
    ownedProbeCleanupVerified: true,
    browserErrors,
    targetId: first.target.targetId,
  }, null, 2));
} finally {
  await secondContext?.close().catch(() => {});
  await firstContext?.close().catch(() => {});
  await server.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
}

const kernelRoot = resolve(repositoryRoot, "packages/kernel");
const requireFromKernel = createRequire(join(kernelRoot, "package.json"));
const vitest = requireFromKernel.resolve("vitest/vitest.mjs");
const memoryGate = spawnSync(process.execPath, [
  vitest,
  "run",
  "test/external-backup-memory.gate.test.ts",
  "--maxWorkers=1",
  "--minWorkers=1",
  "--reporter=verbose",
], {
  cwd: kernelRoot,
  env: { ...process.env, RELEASE_B_MEMORY_GATE: "1" },
  windowsHide: true,
  stdio: "inherit",
});
if (memoryGate.error) throw memoryGate.error;
if (memoryGate.status !== 0)
  throw new Error(`Release B 384 MiB memory gate exited ${String(memoryGate.status)}`);
console.log(JSON.stringify({
  status: "pass",
  gate: "release-b-backup-certification",
  chromiumRestart: "pass",
  maximumArchiveMemory: "pass",
}));
