// Local-only connector that lets Clay use the signed-in Codex CLI session.
// It binds loopback, exposes Clay's existing hosted mutation protocol, and
// never sends Codex credentials to the browser.
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { S1Context } from "@clay/mutation";
import { createApp } from "./app";
import {
  CodexExecModelClient, codexLoginStatus, codexSupportedFeatures, defaultCodexLaunch,
} from "./codex-app-server";

const port = Number(process.env.PORT ?? "8788");
const hostname = "127.0.0.1";
const launch = process.env.CODEX_BIN
  ? { command: process.env.CODEX_BIN, prefix: [] as string[] }
  : defaultCodexLaunch();
const codexModel = process.env.CODEX_MODEL?.trim() || undefined;
if (process.env.CODEX_RUNTIME === "app-server")
  throw new Error("CODEX_RUNTIME=app-server is disabled because it cannot ignore user tool configuration.");
const codexRuntime = "exec";
const connectorToken = randomBytes(32).toString("base64url");
const cwd = process.env.CLAY_CODEX_WORKDIR ?? join(tmpdir(), "clay-codex-runtime");
mkdirSync(cwd, { recursive: true });

const login = codexLoginStatus(launch.command, launch.prefix);
if (!login.loggedIn) {
  throw new Error("Codex is not logged in. Run `codex login`, then start the connector again.");
}
const disabledFeatures = codexSupportedFeatures(launch.command, launch.prefix);

let codexReachable = false;
let codexDetail = "Configured; the first reshape will verify the Codex login";
const makeCodexClient = () => {
  const client = new CodexExecModelClient({
    command: launch.command, prefix: launch.prefix, cwd, model: codexModel,
    disabledFeatures,
  });
  const track = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      const result = await run();
      codexReachable = true; codexDetail = "Connected and verified";
      return result;
    } catch (error) {
      codexReachable = false;
      codexDetail = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };
  return {
    rawPlan: (context: S1Context) =>
      track(() => client.rawPlan(context)),
    rawRepair: (context: S1Context, priorPlanRaw: string, failures: string[]) =>
      track(() => client.rawRepair(context, priorPlanRaw, failures)),
  };
};

const app = createApp({
  model: { provider: "codex",
    model: codexModel ?? `Codex subscription default (${codexRuntime})` },
  makeClient: makeCodexClient,
  modelStatus: () => ({
    model: true, provider: "codex",
    model_id: codexModel ?? `Codex subscription default (${codexRuntime})`,
    reachable: codexReachable, detail: codexDetail,
  }),
  allowedOrigins: ["http://127.0.0.1:4173", "http://localhost:4173"],
  mutationToken: connectorToken,
  exposeMutationTokenOnHealth: true,
  requireAllowedMutationOrigin: true,
  mutationConcurrency: 1,
  mutationRate: { max: 12, windowMs: 60_000 },
});

serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(`Clay Codex connector on http://${hostname}:${port}`);
  console.log(`Codex login: configured, awaiting first reshape verification · ${codexRuntime}${codexModel ? ` · ${codexModel}` : " · subscription default"}`);
});
