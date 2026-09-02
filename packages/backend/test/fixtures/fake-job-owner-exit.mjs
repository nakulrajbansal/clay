import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const runner = process.env.CLAY_JOB_RUNNER;
const pidFile = process.env.CLAY_JOB_TARGET_PID;
const runnerPidFile = process.env.CLAY_JOB_RUNNER_PID;
const readyFile = process.env.CLAY_JOB_TARGET_READY;
const marker = process.env.CLAY_JOB_TARGET_MARKER;
if (!runner || !pidFile || !runnerPidFile || !readyFile || !marker) process.exit(2);

const program = [
  'const fs = require("node:fs");',
  `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid), "utf8");`,
  `fs.writeFileSync(${JSON.stringify(readyFile)}, "ready", "utf8");`,
  `setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, "survived", "utf8"), 5000);`,
  "setInterval(() => undefined, 1000);",
].join("\n");
const child = spawn(runner, [String(process.pid), process.execPath, "-e", program], {
  stdio: "ignore", windowsHide: true, detached: true,
});
writeFileSync(runnerPidFile, String(child.pid), "utf8");
child.unref();
for (let attempt = 0; attempt < 200 && !existsSync(readyFile); attempt++)
  await new Promise(resolve => setTimeout(resolve, 10));
process.exit(existsSync(readyFile) ? 0 : 3);
