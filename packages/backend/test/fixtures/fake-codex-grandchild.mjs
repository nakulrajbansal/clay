import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const marker = process.env.CLAY_CODEX_GRANDCHILD_MARKER;
if (!marker) process.exit(2);
if (process.env.CLAY_CODEX_ROOT_PID_FILE)
  writeFileSync(process.env.CLAY_CODEX_ROOT_PID_FILE, String(process.pid), "utf8");
const readyFile = process.env.CLAY_CODEX_CHILD_READY_FILE;
const nestedTriggerFile = process.env.CLAY_CODEX_NESTED_TRIGGER_FILE;
const nestedPidFile = process.env.CLAY_CODEX_NESTED_PID_FILE;
const nestedReadyFile = process.env.CLAY_CODEX_NESTED_READY_FILE;
const nestedScript = [
  'const fs = require("node:fs");',
  ...(nestedReadyFile ? [`fs.writeFileSync(${JSON.stringify(nestedReadyFile)}, "ready");`] : []),
  `setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, "nested survived"), 5000);`,
].join("\n");
const childScript = [
  'const { spawn } = require("node:child_process");',
  'const fs = require("node:fs");',
  ...(readyFile ? [`fs.writeFileSync(${JSON.stringify(readyFile)}, "ready");`] : []),
  ...(nestedTriggerFile && nestedPidFile ? [
    `const trigger = ${JSON.stringify(nestedTriggerFile)};`,
    "const poll = setInterval(() => {",
    "  if (!fs.existsSync(trigger)) return;",
    "  clearInterval(poll);",
    "  setTimeout(() => {",
    `    const nested = spawn(process.execPath, ["-e", ${JSON.stringify(nestedScript)}], { stdio: "ignore", windowsHide: true, detached: process.platform === "win32" });`,
    "    nested.unref();",
    `    fs.writeFileSync(${JSON.stringify(nestedPidFile)}, String(nested.pid));`,
    "    process.exit(0);",
    "  }, 100);",
    "}, 5);",
  ] : []),
  `setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, "survived"), 5000);`,
].join("\n");
const child = spawn(process.execPath, ["-e", childScript], {
  stdio: "ignore",
  windowsHide: true,
  detached: process.platform === "win32",
});
child.unref();
if (process.env.CLAY_CODEX_CHILD_PID_FILE)
  writeFileSync(process.env.CLAY_CODEX_CHILD_PID_FILE, String(child.pid), "utf8");
if (process.env.CLAY_CODEX_PARENT_EXITS) {
  if (readyFile) {
    for (let attempt = 0; attempt < 200 && !existsSync(readyFile); attempt++)
      await new Promise(resolve => setTimeout(resolve, 10));
    if (!existsSync(readyFile)) process.exit(3);
  }
  if (nestedTriggerFile) {
    writeFileSync(nestedTriggerFile, "go", "utf8");
    if (nestedReadyFile) {
      for (let attempt = 0; attempt < 200 && !existsSync(nestedReadyFile); attempt++)
        await new Promise(resolve => setTimeout(resolve, 10));
      if (!existsSync(nestedReadyFile)) process.exit(4);
    }
    if (child.exitCode === null && child.signalCode === null)
      await new Promise(resolve => child.once("exit", resolve));
  }
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output-last-message");
  const output = args[outputIndex + 1];
  if (!output) process.exit(2);
  writeFileSync(output, process.env.CLAY_CODEX_PLAN ?? "{}", "utf8");
  process.exit(0);
}
setInterval(() => undefined, 1_000);
