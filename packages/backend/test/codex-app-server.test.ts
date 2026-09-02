import { access, mkdtemp, readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { S1Context } from "@clay/mutation";
import {
  CODEX_DISABLED_FEATURES, CodexAppServerModelClient, CodexExecModelClient,
  codexChildEnv, codexLoginStatus, codexSupportedFeatures, waitForExit,
  windowsCompilerEnv, windowsJobRunnerPath,
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

const pidIsAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid process id: ${pid}`);
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

const waitForPidGone = async (pid: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidIsAlive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return !pidIsAlive(pid);
};

const readPidIfPresent = async (path: string): Promise<number | undefined> => {
  try {
    const value = Number(await readFile(path, "utf8"));
    if (!Number.isInteger(value) || value <= 0)
      throw new Error(`Invalid process id in ${path}`);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

describe("Codex app-server model client", () => {
  it("reports when a child is still running after the exit deadline", async () => {
    const child = spawn(process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    try {
      expect(await waitForExit(child, 100)).toBe(false);
    } finally {
      child.kill("SIGKILL");
      expect(await waitForExit(child, 2_000)).toBe(true);
    }
  }, 3_000);

  if (process.platform === "win32") {
    it("leaves no request artifacts when the Job Object runner cannot be built", async () => {
      const dir = await mkdtemp(join(tmpdir(), "clay-codex-runner-failure-"));
      const systemRoot = process.env.SystemRoot;
      const windir = process.env.WINDIR;
      delete process.env.SystemRoot;
      delete process.env.WINDIR;
      try {
        const client = new CodexExecModelClient({
          command: process.execPath, prefix: [], cwd: dir, timeoutMs: 1_000,
        });
        await expect(client.rawPlan(context)).rejects.toThrow(/SystemRoot is unavailable/);
        expect(await readdir(dir)).toEqual([]);
      } finally {
        if (systemRoot !== undefined) process.env.SystemRoot = systemRoot;
        if (windir !== undefined) process.env.WINDIR = windir;
      }
    });
  }

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
  }, 20_000);

  it("runs the Windows-safe exec transport as ephemeral read-only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clay-codex-exec-"));
    const capture = join(dir, "capture.jsonl");
    const fixture = fileURLToPath(new URL("./fixtures/fake-codex-exec.mjs", import.meta.url));
    const client = new CodexExecModelClient({
      command: "node", prefix: [fixture], cwd: dir, timeoutMs: 5_000,
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
  }, 20_000);

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
  }, 20_000);

  it("fails immediately when app-server exits cleanly before a turn completes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clay-codex-exit-"));
    const client = new CodexAppServerModelClient({
      command: process.execPath, args: [fixture], cwd: dir, timeoutMs: 5_000,
      env: { CLAY_CODEX_EXIT_EARLY: "1" },
    });
    await expect(client.rawPlan(context)).rejects.toThrow(
      "Codex app-server stopped before completing the turn.",
    );
  }, 20_000);

  it("aborts the turn if app-server attempts any tool request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clay-codex-tool-"));
    const client = new CodexAppServerModelClient({
      command: process.execPath, args: [fixture], cwd: dir, timeoutMs: 5_000,
      env: { CLAY_CODEX_TOOL_REQUEST: "1" },
    });
    await expect(client.rawPlan(context)).rejects.toThrow(/disallowed request: tool\/call/);
  }, 20_000);

  it("passes only an allowlisted environment unless the caller explicitly injects a test value", () => {
    process.env.CLAY_SECRET_SENTINEL = "must-not-cross";
    try {
      const env = codexChildEnv({ CLAY_EXPLICIT: "yes" });
      expect(env.CLAY_SECRET_SENTINEL).toBeUndefined();
      expect(env.CLAY_EXPLICIT).toBe("yes");
      expect(env.PATH).toBe(process.env.PATH);
      const compilerEnv = windowsCompilerEnv();
      expect(compilerEnv.CLAY_SECRET_SENTINEL).toBeUndefined();
      expect(compilerEnv.SystemRoot).toBe(process.env.SystemRoot);
      expect(compilerEnv.PSModulePath).toBeUndefined();
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
    const rootPidFile = join(dir, "orphan-root.pid");
    const childPidFile = join(dir, "orphan-child.pid");
    const childReadyFile = join(dir, "orphan-child.ready");
    const nestedTriggerFile = join(dir, "nested.trigger");
    const nestedPidFile = join(dir, "nested.pid");
    const nestedReadyFile = join(dir, "nested.ready");
    const fixture = fileURLToPath(new URL(
      "./fixtures/fake-codex-grandchild.mjs", import.meta.url,
    ));
    const client = new CodexExecModelClient({
      command: process.execPath, prefix: [fixture], cwd: dir, timeoutMs: 5_000,
      env: {
        CLAY_CODEX_GRANDCHILD_MARKER: marker,
        CLAY_CODEX_ROOT_PID_FILE: rootPidFile,
        CLAY_CODEX_CHILD_PID_FILE: childPidFile,
        CLAY_CODEX_CHILD_READY_FILE: childReadyFile,
        CLAY_CODEX_NESTED_TRIGGER_FILE: nestedTriggerFile,
        CLAY_CODEX_NESTED_PID_FILE: nestedPidFile,
        CLAY_CODEX_NESTED_READY_FILE: nestedReadyFile,
        CLAY_CODEX_PARENT_EXITS: "1",
        CLAY_CODEX_PLAN: RAW_PLAN,
      },
    });
    let rootPid: number | undefined;
    let childPid: number | undefined;
    let nestedPid: number | undefined;
    try {
      expect(await client.rawPlan(context)).toBe(RAW_PLAN);
      expect(await readFile(childReadyFile, "utf8")).toBe("ready");
      expect(await readFile(nestedReadyFile, "utf8")).toBe("ready");
      rootPid = Number(await readFile(rootPidFile, "utf8"));
      childPid = Number(await readFile(childPidFile, "utf8"));
      nestedPid = Number(await readFile(nestedPidFile, "utf8"));
      expect(Number.isInteger(rootPid) && rootPid > 0).toBe(true);
      expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
      expect(Number.isInteger(nestedPid) && nestedPid > 0).toBe(true);
      expect(() => process.kill(rootPid!, 0)).toThrow();
      expect(() => process.kill(childPid!, 0)).toThrow();
      expect(() => process.kill(nestedPid!, 0)).toThrow();
      await expect(access(marker)).rejects.toThrow();
    } finally {
      rootPid ??= await readPidIfPresent(rootPidFile);
      childPid ??= await readPidIfPresent(childPidFile);
      nestedPid ??= await readPidIfPresent(nestedPidFile);
      for (const pid of [rootPid, childPid, nestedPid])
        if (pid !== undefined && pidIsAlive(pid))
          try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
  }, 25_000);

  if (process.platform === "win32") {
    it("builds the source-controlled Windows Job Object runner", async () => {
      const runner = windowsJobRunnerPath();
      await expect(access(runner)).resolves.toBeUndefined();
      expect((await readFile(runner)).subarray(0, 2).toString("ascii")).toBe("MZ");
    }, 20_000);

    it("closes the Job Object when the Clay owner exits unexpectedly", async () => {
      const dir = await mkdtemp(join(tmpdir(), "clay-job-owner-exit-"));
      const targetPidFile = join(dir, "target.pid");
      const runnerPidFile = join(dir, "runner.pid");
      const readyFile = join(dir, "target.ready");
      const marker = join(dir, "target-survived.txt");
      let targetPid: number | undefined;
      let runnerPid: number | undefined;
      try {
        const owner = spawn(process.execPath, [
          fileURLToPath(new URL("./fixtures/fake-job-owner-exit.mjs", import.meta.url)),
        ], {
          env: {
            ...process.env,
            CLAY_JOB_RUNNER: windowsJobRunnerPath(),
            CLAY_JOB_TARGET_PID: targetPidFile,
            CLAY_JOB_RUNNER_PID: runnerPidFile,
            CLAY_JOB_TARGET_READY: readyFile,
            CLAY_JOB_TARGET_MARKER: marker,
          },
          stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
        });
        const ownerCode = await new Promise<number | null>((resolve, reject) => {
          owner.once("error", reject); owner.once("exit", resolve);
        });
        expect(ownerCode).toBe(0);
        expect(await readFile(readyFile, "utf8")).toBe("ready");
        targetPid = Number(await readFile(targetPidFile, "utf8"));
        runnerPid = Number(await readFile(runnerPidFile, "utf8"));
        expect(Number.isInteger(targetPid) && targetPid > 0).toBe(true);
        expect(Number.isInteger(runnerPid) && runnerPid > 0).toBe(true);
        expect(await waitForPidGone(targetPid, 3_000)).toBe(true);
        expect(await waitForPidGone(runnerPid, 3_000)).toBe(true);
        await expect(access(marker)).rejects.toThrow();
      } finally {
        runnerPid ??= await readPidIfPresent(runnerPidFile);
        targetPid ??= await readPidIfPresent(targetPidFile);
        for (const pid of [runnerPid, targetPid]) {
          if (pid !== undefined && pidIsAlive(pid)) {
            try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
          }
        }
      }
    }, 20_000);

    it("kills the complete Windows process tree before deleting request artifacts", async () => {
      const dir = await mkdtemp(join(tmpdir(), "clay-codex-tree-"));
      const marker = join(dir, "grandchild-survived.txt");
      const rootPidFile = join(dir, "root.pid");
      const childPidFile = join(dir, "grandchild.pid");
      const childReadyFile = join(dir, "grandchild.ready");
      const fixture = fileURLToPath(new URL(
        "./fixtures/fake-codex-grandchild.mjs", import.meta.url,
      ));
      const client = new CodexExecModelClient({
        command: process.execPath, prefix: [fixture], cwd: dir, timeoutMs: 1_000,
        env: {
          CLAY_CODEX_GRANDCHILD_MARKER: marker,
          CLAY_CODEX_ROOT_PID_FILE: rootPidFile,
          CLAY_CODEX_CHILD_PID_FILE: childPidFile,
          CLAY_CODEX_CHILD_READY_FILE: childReadyFile,
        },
      });
      let rootPid: number | undefined;
      let childPid: number | undefined;
      try {
        await expect(client.rawPlan(context)).rejects.toThrow("Codex exec timed out");
        expect(await readFile(childReadyFile, "utf8")).toBe("ready");
        rootPid = Number(await readFile(rootPidFile, "utf8"));
        childPid = Number(await readFile(childPidFile, "utf8"));
        expect(Number.isInteger(rootPid) && rootPid > 0).toBe(true);
        expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
        expect(() => process.kill(rootPid!, 0)).toThrow();
        expect(() => process.kill(childPid!, 0)).toThrow();
        await expect(access(marker)).rejects.toThrow();
        expect((await readdir(dir)).filter(name => name.startsWith("clay-codex-output-")
          || name === "clay-mutation-plan.schema.json")).toEqual([]);
      } finally {
        rootPid ??= await readPidIfPresent(rootPidFile);
        childPid ??= await readPidIfPresent(childPidFile);
        for (const pid of [rootPid, childPid])
          if (pid !== undefined && pidIsAlive(pid))
            try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
      }
    }, 20_000);
  }
});
