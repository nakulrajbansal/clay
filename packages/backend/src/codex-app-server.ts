import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import apiSchemaRaw from "@clay/schema/mutation-plan-api.json";
import {
  buildRepairTurn, buildSystemPrompt, buildUserTurn, type S1Context,
} from "@clay/mutation";

export type CodexAppServerOptions = {
  command?: string;
  args?: string[];
  cwd: string;
  model?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
};

export const CODEX_DISABLED_FEATURES = [
  "shell_tool", "multi_agent", "apps", "browser_use", "computer_use",
  "image_generation", "view_image", "hooks", "plugins", "skill_search", "code_mode_host",
  "in_app_browser", "in_app_local_automation",
] as const;

const ENV_ALLOWLIST = [
  "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH",
  "PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP",
  "CODEX_HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
] as const;

const WINDOWS_CLEANUP_ENV_ALLOWLIST = [
  "ALLUSERSPROFILE", "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
  "ProgramW6432", "PSModulePath", "SystemDrive", "OS", "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION", "USERDOMAIN", "USERNAME",
] as const;

export function codexChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra, RUST_LOG: "warn" };
}

export function windowsCleanupEnv(): NodeJS.ProcessEnv {
  const env = codexChildEnv();
  for (const key of WINDOWS_CLEANUP_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function codexLoginStatus(
  command: string,
  prefix: readonly string[],
  extraEnv: Record<string, string> = {},
): { loggedIn: boolean; detail: string } {
  const result = spawnSync(command, [...prefix, "login", "status"], {
    encoding: "utf8", windowsHide: true, env: codexChildEnv(extraEnv),
  });
  const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { loggedIn: result.status === 0 && detail.includes("Logged in"), detail };
}

export function codexSupportedFeatures(
  command: string,
  prefix: readonly string[],
): string[] {
  const result = spawnSync(command, [...prefix, "features", "list"], {
    encoding: "utf8", windowsHide: true, env: codexChildEnv(),
  });
  if (result.status !== 0)
    throw new Error("Could not inspect the Codex feature surface; refusing to start the connector.");
  const names = String(result.stdout).split(/\r?\n/)
    .map(line => line.trim().split(/\s+/)[0] ?? "")
    .filter(name => /^[a-z][a-z0-9_]*$/.test(name));
  if (names.length === 0)
    throw new Error("Codex reported no feature surface; refusing to start the connector.");
  return [...new Set(names)];
}

export async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 5_000,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onExit = (): void => finish(true);
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    child.once("exit", onExit);
    timer = setTimeout(() => finish(false), timeoutMs);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

export type CleanupResult = { completed: boolean; code: number | null };

export async function runBoundedCleanup(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv = codexChildEnv(),
): Promise<CleanupResult> {
  return new Promise(resolve => {
    const helper = spawn(command, [...args], {
      windowsHide: true, stdio: ["ignore", "ignore", "ignore"], env,
    });
    let settled = false;
    const finish = (result: CleanupResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    helper.once("error", () => finish({ completed: false, code: null }));
    helper.once("exit", code => finish({ completed: true, code }));
    const timer = setTimeout(() => {
      try { helper.kill("SIGKILL"); } catch { /* helper already stopped */ }
      helper.unref();
      finish({ completed: false, code: null });
    }, timeoutMs);
  });
}

export async function terminateProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    const root = child.pid;
    const cleanupEnv = windowsCleanupEnv();
    const parentWasRunning = child.exitCode === null && child.signalCode === null;
    if (parentWasRunning) {
      const direct = await runBoundedCleanup(
        "taskkill", ["/PID", String(root), "/T", "/F"], 1_500, cleanupEnv,
      );
      if (direct.completed && direct.code === 0 && await waitForExit(child, 1_000)) return;
    }
    const script = [
      `$root=${root}`,
      "$ErrorActionPreference='Stop'",
      "try{",
      "$targets=New-Object 'System.Collections.Generic.HashSet[int]'",
      "$frontier=@($root)",
      "while($frontier.Count -gt 0){$next=@();foreach($parentId in $frontier){$children=@(Get-WmiObject Win32_Process -Filter \"ParentProcessId = $parentId\" -ErrorAction Stop);foreach($p in $children){if($targets.Add([int]$p.ProcessId)){$next+=[int]$p.ProcessId}}};$frontier=$next}",
      "foreach($processId in $targets){Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue}",
      "Stop-Process -Id $root -Force -ErrorAction SilentlyContinue",
      "Start-Sleep -Milliseconds 50",
      "foreach($processId in $targets){if(Get-Process -Id $processId -ErrorAction SilentlyContinue){exit 3}}",
      "if(Get-Process -Id $root -ErrorAction SilentlyContinue){exit 4}",
      "exit 0",
      "}catch{exit 2}",
    ].join(";");
    const orphanSweep = await runBoundedCleanup(
      "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      10_000, cleanupEnv,
    );
    if (!orphanSweep.completed || orphanSweep.code !== 0)
      throw new Error(`Codex process cleanup could not be verified `
        + `(completed=${orphanSweep.completed}, code=${String(orphanSweep.code)}).`);
  } else {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
  }
  if (!await waitForExit(child, 1_000))
    throw new Error("Codex process cleanup could not be verified.");
}

export function defaultCodexLaunch(): { command: string; prefix: string[] } {
  if (process.platform !== "win32") return { command: "codex", prefix: [] };
  const appData = process.env.APPDATA;
  if (!appData) throw new Error("APPDATA is unavailable; cannot locate Codex CLI");
  return { command: process.execPath,
    prefix: [join(appData, "npm", "node_modules", "@openai", "codex", "bin", "codex.js")] };
}

type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
};

type Pending = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

function stripAnnotations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAnnotations);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key !== "$comment") out[key] = stripAnnotations(item);
    }
    return out;
  }
  return value;
}

const outputSchema = stripAnnotations(apiSchemaRaw) as Record<string, unknown>;

function strictifyObjects(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictifyObjects);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) out[key] = strictifyObjects(value);
    if (out.properties && typeof out.properties === "object") {
      out.required = Object.keys(out.properties as Record<string, unknown>);
      out.additionalProperties = false;
    }
    return out;
  }
  return node;
}
const strictOutputSchema = strictifyObjects(outputSchema) as Record<string, unknown>;

export class CodexAppServerModelClient {
  constructor(private readonly options: CodexAppServerOptions) {}

  rawPlan(context: S1Context): Promise<string> {
    return this.run(buildUserTurn(context));
  }

  rawRepair(context: S1Context, priorPlanRaw: string, failures: string[]): Promise<string> {
    const prompt = `${buildUserTurn(context)}\n\n${buildRepairTurn(failures, priorPlanRaw)}`;
    return this.run(prompt);
  }

  private async run(prompt: string): Promise<string> {
    if (!this.options.args)
      throw new Error("Codex app-server transport is disabled because it cannot ignore user tool configuration.");
    const launch = defaultCodexLaunch();
    const command = this.options.command ?? launch.command;
    const args = this.options.args;
    const child = spawn(command, args, {
      cwd: this.options.cwd,
      env: codexChildEnv(this.options.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    return this.drive(child, prompt);
  }

  private async drive(child: ChildProcessWithoutNullStreams, prompt: string): Promise<string> {
    const timeoutMs = this.options.timeoutMs ?? 180_000;
    const pending = new Map<number | string, Pending>();
    const stderr: string[] = [];
    let nextId = 1;
    let finalText = "";
    let completeResolve!: () => void;
    let completeReject!: (error: Error) => void;
    let completionSettled = false;
    const completed = new Promise<void>((resolve, reject) => {
      completeResolve = resolve;
      completeReject = reject;
    });
    void completed.catch(() => undefined);
    const resolveCompletion = (): void => {
      if (completionSettled) return;
      completionSettled = true; completeResolve();
    };
    const rejectCompletion = (error: Error): void => {
      if (completionSettled) return;
      completionSettled = true; completeReject(error);
    };

    const send = (message: RpcMessage): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const request = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Codex app-server ${method} timed out`));
        }, Math.min(timeoutMs, 15_000));
        pending.set(id, { resolve, reject, timer });
        send({ id, method, params });
      });
    };
    const abort = (error: Error): void => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer); entry.reject(error);
      }
      pending.clear();
      rejectCompletion(error);
    };
    const completionTimer = setTimeout(() => {
      abort(new Error(`Codex turn timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const stdout = createInterface({ input: child.stdout });
    const stderrReader = createInterface({ input: child.stderr });
    stderrReader.on("line", line => {
      stderr.push(line);
      if (stderr.length > 20) stderr.shift();
    });
    stdout.on("line", line => {
      let message: RpcMessage;
      try { message = JSON.parse(line) as RpcMessage; }
      catch { return; }
      if (message.id !== undefined && (message.result || message.error)) {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error)
          entry.reject(new Error(message.error.message ?? "Codex app-server request failed"));
        else entry.resolve(message.result ?? {});
        return;
      }
      if (message.id !== undefined && message.method) {
        send({ id: message.id, error: { code: -32601,
          message: "Clay local connector does not permit tool or approval requests" } });
        abort(new Error(`Codex attempted a disallowed request: ${message.method}`));
        return;
      }
      if (message.method === "item/completed") {
        const item = (message.params?.item ?? {}) as Record<string, unknown>;
        if (item.type === "agentMessage" && typeof item.text === "string")
          finalText = item.text;
      }
      if (message.method === "turn/completed") {
        const turn = (message.params?.turn ?? {}) as Record<string, unknown>;
        if (turn.status === "failed")
          abort(new Error(`Codex turn failed: ${JSON.stringify(turn.error ?? {})}`));
        else resolveCompletion();
      }
    });
    child.once("error", error => abort(error));
    child.once("exit", code => {
      if (completionSettled && pending.size === 0) return;
      if (code !== 0) {
        console.error("[clay codex app-server]", stderr.join("\n"));
      }
      abort(new Error(code === 0
        ? "Codex app-server stopped before completing the turn."
        : "Codex app-server stopped. See the local connector log."));
    });

    try {
      await request("initialize", {
        clientInfo: { name: "clay_local", title: "Clay Local Connector", version: "0.1.0" },
      });
      send({ method: "initialized", params: {} });
      const selectedModel = this.options.model;
      const threadResult = await request("thread/start", {
        cwd: this.options.cwd,
        ...(selectedModel ? { model: selectedModel } : {}),
        ephemeral: true,
        approvalPolicy: "never",
        sandbox: "read-only",
        personality: "pragmatic",
        baseInstructions: buildSystemPrompt(),
      });
      const thread = (threadResult.thread ?? {}) as Record<string, unknown>;
      const threadId = String(thread.id ?? "");
      if (!threadId) throw new Error("Codex app-server returned no thread id");
      await request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt }],
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        ...(selectedModel ? { model: selectedModel } : {}),
        outputSchema: strictOutputSchema,
      });
      await completed;
      if (!finalText) throw new Error("Codex app-server returned no final agent message");
      return finalText;
    } finally {
      clearTimeout(completionTimer);
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("Codex app-server closed"));
      }
      pending.clear();
      stdout.close();
      stderrReader.close();
      child.stdin.end();
      await terminateProcessTree(child);
    }
  }
}

export type CodexExecOptions = {
  command?: string; prefix?: string[]; cwd: string; model?: string;
  timeoutMs?: number; env?: Record<string, string>;
  disabledFeatures?: readonly string[];
};

export class CodexExecModelClient {
  constructor(private readonly options: CodexExecOptions) {}

  rawPlan(context: S1Context): Promise<string> {
    return this.run(buildUserTurn(context));
  }

  rawRepair(context: S1Context, priorPlanRaw: string, failures: string[]): Promise<string> {
    return this.run(`${buildUserTurn(context)}\n\n${
      buildRepairTurn(failures, priorPlanRaw)}`);
  }

  private async run(userPrompt: string): Promise<string> {
    const launch = defaultCodexLaunch();
    const command = this.options.command ?? launch.command;
    const prefix = this.options.prefix ?? launch.prefix;
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const schemaPath = join(this.options.cwd, "clay-mutation-plan.schema.json");
    const outputPath = join(this.options.cwd, `clay-codex-output-${nonce}.json`);
    await writeFile(schemaPath, JSON.stringify(strictOutputSchema), "utf8");
    const args = [
      ...prefix, "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules",
      "--strict-config",
      ...(this.options.disabledFeatures ?? CODEX_DISABLED_FEATURES)
        .flatMap(feature => ["--disable", feature]),
      "--sandbox", "read-only", "--skip-git-repo-check",
      "--output-schema", schemaPath, "--output-last-message", outputPath,
      "--cd", this.options.cwd,
      ...(this.options.model ? ["--model", this.options.model] : []), "-",
    ];
    const child = spawn(command, args, {
      cwd: this.options.cwd,
      env: codexChildEnv(this.options.env),
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      detached: process.platform !== "win32",
    });
    const stderr: string[] = [];
    child.stderr.on("data", chunk => stderr.push(String(chunk).slice(0, 2000)));
    const timeoutMs = this.options.timeoutMs ?? 600_000;
    let timedOut = false;
    try {
      child.stdin.end(`${buildSystemPrompt()}\n\n${userPrompt}\n\n`
        + "Do not call tools. Return only the JSON object required by the output schema.");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          timedOut = true; reject(new Error("Codex exec timed out"));
        }, timeoutMs);
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("exit", code => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else {
            const detail = stderr.join("\n").slice(-4000);
            if (timedOut) { reject(new Error("Codex exec timed out")); return; }
            if (/invalid refresh token|could not parse your authentication token|access token could not be refreshed/i.test(detail))
              reject(new Error("Codex login expired. Run `codex logout`, then `codex login`, and restart `pnpm codex`."));
            else {
              console.error("[clay codex exec]", detail);
              reject(new Error("Codex exec failed. See the local connector log."));
            }
          }
        });
      });
      const raw = (await readFile(outputPath, "utf8")).trim();
      if (!raw) throw new Error("Codex exec returned no final message");
      return raw;
    } finally {
      await terminateProcessTree(child);
      await Promise.all([
        unlink(outputPath).catch(() => undefined),
        unlink(schemaPath).catch(() => undefined),
      ]);
    }
  }
}
