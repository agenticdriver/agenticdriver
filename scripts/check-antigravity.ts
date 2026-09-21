/** Native compatibility inspection only: never write a prompt to stdin. */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { runProcess } from "../src/providers/local-cli.js";

const agent = "agenticdriver-readiness";
export const restrictedAgent = `---
name: ${agent}
description: Answer using only the supplied conversation.
mainAgent: true
subagent: false
excludeDefaultComponents: true
inheritCustomizations: false
tools: []
mcpServers: []
skills: []
plugins: []
commandExecutionPolicy: "off"
---
Use only supplied conversation content. No tools or external context are available.
`;
export interface AntigravityReadiness {
  status:
    | "ready-for-live-check"
    | "unsupported-tools"
    | "unexpected-selection"
    | "invalid-output"
    | "unavailable"
    | "probe-timeout"
    | "cancelled"
    | "upgrade-required"
    | "unsupported-platform";
  version?: string;
  toolCount?: number;
  modelMatches?: boolean;
  agentMatches?: boolean;
  strictPermissions?: boolean;
  promptSubmitted: false;
  liveCertified: false;
}
const result = (
  status: AntigravityReadiness["status"],
  extra: Partial<AntigravityReadiness> = {},
): AntigravityReadiness => ({
  ...extra,
  status,
  promptSubmitted: false,
  liveCertified: false,
});
const Init = z.object({
  event: z.literal("init"),
  init: z.object({
    model: z.string().max(200),
    agent: z.string().max(200),
    tools: z.array(z.string().min(1).max(200)).max(256),
    permission_mode: z.string().max(100),
  }),
});

/** Exported for credential-free subprocess fixtures, not an inference API. */
export function inspectAntigravityStream(options: {
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  model: string;
  signal: AbortSignal;
}): Promise<AntigravityReadiness> {
  if (options.signal.aborted)
    return Promise.resolve(
      result(
        options.signal.reason?.name === "TimeoutError"
          ? "probe-timeout"
          : "cancelled",
      ),
    );
  return new Promise((resolveResult) => {
    const child = spawn(options.binary, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: "pipe",
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let selected: AntigravityReadiness | undefined;
    let bytes = 0,
      pending = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* Already reaped. */
      }
    };
    const finish = (value: AntigravityReadiness) => {
      if (selected) return;
      selected = value;
      // EOF closes the official input session. No user event is ever sent.
      child.stdin.end();
      killTimer = setTimeout(() => kill("SIGKILL"), 1000);
      killTimer.unref();
    };
    const cancelled = () => {
      selected = result(
        options.signal.reason?.name === "TimeoutError"
          ? "probe-timeout"
          : "cancelled",
      );
      child.stdin.end();
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 1000);
      killTimer.unref();
    };
    const bounded = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 65_536) {
        finish(result("invalid-output"));
        kill("SIGTERM");
        return false;
      }
      return true;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (!bounded(chunk) || selected) return;
      try {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          const parsed = Init.safeParse(JSON.parse(line));
          if (!parsed.success) {
            finish(result("invalid-output"));
            return;
          }
          const init = parsed.data.init;
          const metadata = {
            toolCount: init.tools.length,
            modelMatches: init.model === options.model,
            agentMatches: init.agent === agent,
            strictPermissions: init.permission_mode === "strict",
          };
          finish(
            result(
              !metadata.modelMatches ||
                !metadata.agentMatches ||
                !metadata.strictPermissions
                ? "unexpected-selection"
                : metadata.toolCount
                  ? "unsupported-tools"
                  : "ready-for-live-check",
              metadata,
            ),
          );
          break;
        }
      } catch {
        finish(result("invalid-output"));
      }
    });
    // Never export native diagnostics, account identifiers or arbitrary tool names.
    child.stderr.on("data", (chunk: Buffer) => {
      bounded(chunk);
    });
    child.stdin.on("error", () => {});
    child.once("error", () => {
      selected = result("unavailable");
    });
    child.once("close", () => {
      options.signal.removeEventListener("abort", cancelled);
      clearTimeout(killTimer);
      kill("SIGKILL");
      resolveResult(selected ?? result("invalid-output"));
    });
    options.signal.addEventListener("abort", cancelled, { once: true });
    if (options.signal.aborted) cancelled();
  });
}

/** Linux probe in a temporary home/configuration view; no user credentials are inspected. */
export async function checkAntigravity(options: {
  binary: string;
  model: string;
  signal?: AbortSignal;
}): Promise<AntigravityReadiness> {
  if (process.platform !== "linux") return result("unsupported-platform");
  if (
    !isAbsolute(options.binary) ||
    !options.model ||
    options.model.length > 200
  )
    return result("unavailable");
  const root = await mkdtemp(
    join(tmpdir(), "agenticdriver-antigravity-check-"),
  );
  // This bounds readiness I/O only. No inference is started, timed or cancelled.
  const signal = AbortSignal.any([
    AbortSignal.timeout(20_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const env = Object.fromEntries(
    ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL"].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]!]],
    ),
  );
  try {
    if (!(await stat(options.binary)).isFile()) return result("unavailable");
    const fakeHome = join(root, "profile"),
      workspace = join(root, "workspace");
    const cli = join(fakeHome, ".gemini/antigravity-cli"),
      config = join(fakeHome, ".gemini/config");
    await mkdir(join(config, "agents", agent), { recursive: true });
    await mkdir(cli, { recursive: true });
    await mkdir(workspace);
    await writeFile(join(config, "agents", agent, "agent.md"), restrictedAgent);
    await writeFile(join(config, "mcp_config.json"), '{"mcpServers":{}}');
    await writeFile(join(config, "config.json"), "{}");
    await writeFile(
      join(cli, "settings.json"),
      JSON.stringify({
        enableTelemetry: false,
        useG1Credits: false,
        toolPermission: "strict",
        allowNonWorkspaceAccess: false,
        permissions: {
          deny: [
            "read_file(*)",
            "write_file(*)",
            "read_url(*)",
            "execute_url(*)",
            "command(*)",
            "mcp(*)",
          ],
        },
      }),
    );
    const mountedBinary = join(root, "agy");
    const prefix = [
      "--ro-bind",
      "/",
      "/",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--unshare-pid",
      "--die-with-parent",
      "--new-session",
      "--tmpfs",
      homedir(),
      "--bind",
      fakeHome,
      homedir(),
      "--tmpfs",
      "/tmp",
      "--bind",
      root,
      root,
      "--ro-bind",
      options.binary,
      mountedBinary,
      "--chdir",
      workspace,
      "--",
      mountedBinary,
    ];
    const version = (
      await runProcess("bwrap", [...prefix, "--version"], { env, signal })
    ).trim();
    const matched = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (
      !matched ||
      Number(matched[1]) !== 1 ||
      Number(matched[2]) < 2 ||
      (Number(matched[2]) === 2 && Number(matched[3]) < 6)
    )
      return result("upgrade-required");
    const help = await runProcess("bwrap", [...prefix, "--help"], {
      env,
      signal,
      includeStderr: true,
    });
    if (
      ![
        "--input-format",
        "--output-format",
        "--agent",
        "--model",
        "--disable-slash-commands",
        "0 waits until the turn completes",
      ].every((flag) => help.includes(flag))
    )
      return result("upgrade-required", { version });
    const checked = await inspectAntigravityStream({
      binary: "bwrap",
      args: [
        ...prefix,
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--agent",
        agent,
        "--model",
        options.model,
        "--disable-slash-commands",
        "--print-timeout",
        "0",
      ],
      env,
      model: options.model,
      signal,
    });
    return { ...checked, version };
  } catch {
    return result(
      signal.aborted
        ? signal.reason?.name === "TimeoutError"
          ? "probe-timeout"
          : "cancelled"
        : "unavailable",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--binary" || args[2] !== "--model") {
    console.error(
      "Usage: npm run check:antigravity -- --binary /absolute/path/to/agy --model SELECTED_MODEL",
    );
    process.exitCode = 2;
  } else {
    const checked = await checkAntigravity({
      binary: args[1]!,
      model: args[3]!,
    });
    console.log(JSON.stringify(checked));
    process.exitCode = checked.status === "ready-for-live-check" ? 0 : 1;
  }
}
