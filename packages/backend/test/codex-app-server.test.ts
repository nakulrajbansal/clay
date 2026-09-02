import { access, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { S1Context } from "@clay/mutation";
import {
  CODEX_DISABLED_FEATURES, CodexAppServerModelClient, CodexExecModelClient,
  codexChildEnv, codexLoginStatus, codexSupportedFeatures,
} from "../src/codex-app-server";

const RAW_PLAN = JSON.stringify({
  api: 1, summary: "Adds a panel.", user_facing_diff: [],
  clarifying_question: null, assumptions: [], migration: null,
  panels: [], remove_panels: [], confidence: 0.9,
});
const fixture = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));
const context: S1Context = {
  registry: [], panels: [], recentSummaries: [], intent: "add a panel",
};

describe("Codex app-server model client", () => {
  it("uses a read-only ephemeral turn and extracts structured final output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clay-codex-test-"));
    const capture = join(dir, "messages.jsonl");
    const client = new CodexAppServerModelClient({
      command: process.execPath,
      args: [fixture],
      cwd: dir,
      model: "gpt-5.6-codex",
      timeoutMs: 5_000,
      env: { CLAY_CODEX_CAPTURE: capture, CLAY_CODEX_PLAN: RAW_PLAN },
    });

    expect(await client.rawPlan(context)).toBe(RAW_PLAN);

    const messages = (await readFile(capture, "utf8")).trim().split("\n")
      .map(line => JSON.parse(line) as { method?: string; params?: Record<string, any> });
    const thread = messages.find(message => message.method === "thread/start");
    const turn = messages.find(message => message.method === "turn/start");
    expect(thread).toBeDefined();
    expect(turn).toBeDefined();
    const threadParams = thread!.params!;
    const turnParams = turn!.params!;
    expect(threadParams).toMatchObject({ ephemeral: true, model: "gpt-5.6-codex",
      approvalPolicy: "never", sandbox: "read-only" });
    expect(turnParams.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
    expect((turnParams.outputSchema as { properties: { api: unknown } }).properties.api).toBeDefined();
    expect(threadParams.baseInstructions).toContain("You write MutationPlans for Clay");
    expect((turnParams.input as Array<{ text: string }>)[0]!.text)
      .toContain("<intent>add a panel</intent>");
  });

  it("runs the Windows-safe exec transport as ephemeral read-only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clay-codex-exec-"));
    const capture = join(dir, "capture.jsonl");
    const fixture = fileURLToPath(new URL("./fixtures/fake-codex-exec.mjs", import.meta.url));
    const client = new CodexExecModelClient({
      command: process.execPath, prefix: [fixture], cwd: dir, timeoutMs: 5_000,
      env: { CLAY_CODEX_CAPTURE: capture, CLAY_CODEX_PLAN: RAW_PLAN },
    });
    expect(await client.rawPlan(context)).toBe(RAW_PLAN);
    const call = JSON.parse((await readFile(capture, "utf8")).trim()) as {
      args: string[]; input: string;
    };
    expect(call.args).toEqual(expect.arrayContaining([
      "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules",
      "--sandbox", "read-only", "--output-schema", "--output-last-message",
    ]));
    expect(call.args).toContain("--strict-config");
    for (const feature of CODEX_DISABLED_FEATURES) {
      const index = call.args.indexOf(feature);
      expect(index).toBeGreaterThan(0);
      expect(call.args[index - 1]).toBe("--disable");
    }
    expect(call.input).toContain("<intent>add a panel</intent>");
  });

  it("maps an expired Codex login to one actionable error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clay-codex-auth-"));
    const fixture = fileURLToPath(new URL("./fixtures/fake-codex-exec.mjs", import.meta.url));
    const client = new CodexExecModelClient({
      command: process.execPath, prefix: [fixture], cwd: dir, timeoutMs: 5_000,
      env: { CLAY_CODEX_ERROR: "1" },
    });
    await expect(client.rawPlan(context)).rejects.toThrow(
      "Codex login expired. Run `codex logout`, then `codex login`, and restart `pnpm codex`.",
    );
  });

  it("fails immediately when app-server exits cleanly before a turn completes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clay-codex-exit-"));
    const client = new CodexAppServerModelClient({
      command: process.execPath, args: [fixture], cwd: dir, timeoutMs: 5_000,
      env: { CLAY_CODEX_EXIT_EARLY: "1" },
    });
    await expect(client.rawPlan(context)).rejects.toThrow(
      "Codex app-server stopped before completing the turn.",
    );
  });

  it("aborts the turn if app-server attempts any tool request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clay-codex-tool-"));
    const client = new CodexAppServerModelClient({
      command: process.execPath, args: [fixture], cwd: dir, timeoutMs: 5_000,
      env: { CLAY_CODEX_TOOL_REQUEST: "1" },
    });
    await expect(client.rawPlan(context)).rejects.toThrow(/disallowed request: tool\/call/);
  });

  it("passes only an allowlisted environment unless the caller explicitly injects a test value", () => {
    process.env.CLAY_SECRET_SENTINEL = "must-not-cross";
    try {
      const env = codexChildEnv({ CLAY_TEST_ONLY: "yes" });
      expect(env.CLAY_SECRET_SENTINEL).toBeUndefined();
      expect(env.CLAY_TEST_ONLY).toBe("yes");
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      delete process.env.CLAY_SECRET_SENTINEL;
    }
  });

  it("uses the allowlisted environment for login preflight and disables every reported feature", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clay-codex-control-"));
    const capture = join(dir, "login-env.json");
    const control = fileURLToPath(new URL("./fixtures/fake-codex-control.mjs", import.meta.url));
    process.env.CLAY_SECRET_SENTINEL = "must-not-cross";
    try {
      const status = codexLoginStatus(process.execPath, [control], {
        CLAY_CODEX_CAPTURE: capture, CLAY_ALLOWED_SENTINEL: "yes",
      });
      expect(status.loggedIn).toBe(true);
      expect(JSON.parse(await readFile(capture, "utf8"))).toEqual({
        leaked: null, allowed: "yes",
      });
      expect(codexSupportedFeatures(process.execPath, [control])).toEqual([
        "shell_tool", "view_image", "future_capability",
      ]);
    } finally { delete process.env.CLAY_SECRET_SENTINEL; }
  });

  it("kills descendants even when the direct Codex parent exits cleanly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clay-codex-orphan-"));
    const marker = join(dir, "orphan-survived.txt");
    const fixture = fileURLToPath(new URL(
      "./fixtures/fake-codex-grandchild.mjs", import.meta.url,
    ));
    const client = new CodexExecModelClient({
      command: process.execPath, prefix: [fixture], cwd: dir, timeoutMs: 5_000,
      env: {
        CLAY_CODEX_GRANDCHILD_MARKER: marker,
        CLAY_CODEX_PARENT_EXITS: "1",
        CLAY_CODEX_PLAN: RAW_PLAN,
      },
    });
    expect(await client.rawPlan(context)).toBe(RAW_PLAN);
    await new Promise(resolve => setTimeout(resolve, 750));
    await expect(access(marker)).rejects.toThrow();
  }, 15_000);

  if (process.platform === "win32") {
    it("kills the complete Windows process tree before deleting request artifacts", async () => {
      const dir = await mkdtemp(join(tmpdir(), "clay-codex-tree-"));
      const marker = join(dir, "grandchild-survived.txt");
      const fixture = fileURLToPath(new URL(
        "./fixtures/fake-codex-grandchild.mjs", import.meta.url,
      ));
      const client = new CodexExecModelClient({
        command: process.execPath, prefix: [fixture], cwd: dir, timeoutMs: 100,
        env: { CLAY_CODEX_GRANDCHILD_MARKER: marker },
      });
      await expect(client.rawPlan(context)).rejects.toThrow("Codex exec timed out");
      await new Promise(resolve => setTimeout(resolve, 750));
      await expect(access(marker)).rejects.toThrow();
      expect((await readdir(dir)).filter(name => name.startsWith("clay-codex-output-")
        || name === "clay-mutation-plan.schema.json")).toEqual([]);
    }, 10_000);
  }
});
