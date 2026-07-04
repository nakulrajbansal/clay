// Nightly regression CLI (doc 08 §4): `pnpm regression`. Prints per-case
// results and the gate verdict; exit 1 if the gate fails.
import { runRegressionSuite } from "./runner";

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Set ANTHROPIC_API_KEY to run the regression suite.");
    process.exit(2);
  }
  console.log("Clay regression suite (25 intents, live model)\n");
  const report = await runRegressionSuite({
    onCase: o => console.log(
      `${o.pass ? "PASS" : "FAIL"}  ${o.id.padEnd(3)} [${o.expect}] ${o.detail}`),
  });
  console.log("\n———");
  console.log(`first-pass commit (1-20): ${(report.firstPassCommitRate * 100).toFixed(0)}% (gate >=90%)`);
  console.log(`clarify hits (5):         ${report.clarifyHits}/5 (gate >=4)`);
  console.log(`adversarial safe (5):     ${report.adversarialSafe}/5 (gate = 5)`);
  console.log(`\nGATE: ${report.passesGate ? "PASS" : "FAIL"}`);
  process.exit(report.passesGate ? 0 : 1);
}

void main();
