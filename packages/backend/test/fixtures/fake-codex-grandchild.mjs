import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const marker = process.env.CLAY_CODEX_GRANDCHILD_MARKER;
if (!marker) process.exit(2);
const child = spawn(process.execPath, ["-e", `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "survived"), 500)`], {
  stdio: "ignore",
  windowsHide: true,
  detached: process.platform === "win32",
});
child.unref();
if (process.env.CLAY_CODEX_PARENT_EXITS) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output-last-message");
  const output = args[outputIndex + 1];
  if (!output) process.exit(2);
  writeFileSync(output, process.env.CLAY_CODEX_PLAN ?? "{}", "utf8");
  process.exit(0);
}
setInterval(() => undefined, 1_000);
