import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { abortable, DriverError } from "../errors.js";
import { cliEnvironment } from "./cli-process.js";
import type { ApiProviderOptions } from "./http.js";

/** One explicit credential, scoped to an operation's fresh private native home. */
export async function claudeApiEnvironment(
  credential: ApiProviderOptions["apiKey"],
  directory: string,
  signal: AbortSignal,
): Promise<NodeJS.ProcessEnv> {
  signal.throwIfAborted();
  let key: string;
  try {
    const value = await abortable(
      Promise.resolve(
        typeof credential === "function" ? credential() : credential,
      ),
      signal,
    );
    key = typeof value === "string" ? value.trim() : "";
    if (!key || key.length > 4096 || /[\r\n\0]/.test(key))
      throw new Error("invalid");
  } catch {
    signal.throwIfAborted();
    throw new DriverError(
      "AUTH_REQUIRED",
      "Supply the explicit Claude API credential through this connection's configured resolver.",
    );
  }
  signal.throwIfAborted();
  const home = join(directory, "api-home");
  const config = join(home, ".claude");
  await mkdir(config, { recursive: true, mode: 0o700 });
  const env = cliEnvironment();
  // No native profile/keychain, cross-provider account, or login-helper environment.
  for (const name of [
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "GEMINI_CLI_HOME",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
  ])
    delete env[name];
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "appdata"),
    LOCALAPPDATA: join(home, "local-appdata"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"),
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_CODE_SIMPLE: "1",
    ANTHROPIC_API_KEY: key,
  };
}
