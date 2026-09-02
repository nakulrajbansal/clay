import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "login" && args[1] === "status") {
  if (process.env.CLAY_CODEX_CAPTURE)
    writeFileSync(process.env.CLAY_CODEX_CAPTURE, JSON.stringify({
      leaked: process.env.CLAY_SECRET_SENTINEL ?? null,
      allowed: process.env.CLAY_ALLOWED_SENTINEL ?? null,
    }), "utf8");
  console.log("Logged in using ChatGPT");
  process.exit(0);
}
if (args[0] === "features" && args[1] === "list") {
  console.log("shell_tool stable true");
  console.log("view_image stable true");
  console.log("future_capability experimental false");
  process.exit(0);
}
process.exit(2);
