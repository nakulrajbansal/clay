import { appendFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const output = args[outputIndex + 1];
if (!output) process.exit(2);
if (process.env.CLAY_CODEX_ERROR) {
  console.error("Invalid refresh token. Your access token could not be refreshed.");
  process.exit(1);
}
let input = "";
for await (const chunk of process.stdin) input += chunk;
writeFileSync(output, process.env.CLAY_CODEX_PLAN ?? "{}", "utf8");
if (process.env.CLAY_CODEX_CAPTURE)
  appendFileSync(process.env.CLAY_CODEX_CAPTURE,
    JSON.stringify({ args, input }) + "\n", "utf8");
