import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { DriverError } from "../errors.js";

export function cliEnvironment(): NodeJS.ProcessEnv {
  const keys = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "DBUS_SESSION_BUS_ADDRESS",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "GEMINI_CLI_HOME",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    "CODEX_CA_CERTIFICATE",
  ];
  return Object.fromEntries(
    keys.flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );
}

/** No shell interpolation; bound output and terminate the process group on cancellation. */
export function runProcess(
  binary: string,
  args: string[],
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    input?: string;
    includeStderr?: boolean;
    /** Parse stdout without retaining a second copy of native protocol data. */
    retainOutput?: boolean;
    onLine?: (line: string) => void;
    /** Interactive stdin for native JSON-RPC. Mutually exclusive with input. */
    onStart?: (write: (data: string) => void, end: () => void) => void;
    acceptedExitCodes?: number[];
    onExit?: (code: number | null) => void;
    /** Trusted diagnostic classifier. Raw stderr is never included in public errors. */
    classifyExit?: (
      code: number | null,
      stderr: string,
    ) => DriverError | undefined;
  },
): Promise<string> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    const diagnostic: Buffer[] = [];
    let diagnosticBytes = 0;
    const decoder = new StringDecoder("utf8");
    let pendingLine = "";
    const acceptText = (text: string, end = false) => {
      if (!options.onLine || failure) return;
      pendingLine += text;
      const lines = pendingLine.split(/\r?\n/);
      pendingLine = end ? "" : lines.pop()!;
      for (const line of lines) if (line.trim()) options.onLine(line);
    };
    let bytes = 0,
      failure: unknown,
      killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* Already exited. */
      }
    };
    const stop = () => {
      terminate("SIGTERM");
      killTimer ??= setTimeout(() => terminate("SIGKILL"), 1000);
      killTimer.unref();
    };
    const abort = () => {
      failure =
        options.signal.reason instanceof DriverError
          ? options.signal.reason
          : new DriverError(
              options.signal.reason?.name === "TimeoutError"
                ? "TIMEOUT"
                : "CANCELLED",
              "The CLI operation was interrupted.",
            );
      stop();
    };
    const receive = (chunk: Buffer, retain: boolean) => {
      bytes += chunk.length;
      if (bytes > 2_000_000) {
        failure = new DriverError(
          "CLI_OUTPUT_LIMIT",
          "The CLI exceeded its output limit.",
        );
        stop();
      } else if (retain) chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      receive(chunk, options.retainOutput !== false);
      try {
        acceptText(decoder.write(chunk));
      } catch (error) {
        failure = error;
        stop();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      receive(chunk, options.includeStderr ?? false);
      if (options.classifyExit && diagnosticBytes < 65_536) {
        const part = chunk.subarray(0, 65_536 - diagnosticBytes);
        diagnostic.push(part);
        diagnosticBytes += part.length;
      }
    });
    child.stdin.on("error", () => {});
    child.once("error", () => {
      failure = new DriverError(
        "CLI_UNAVAILABLE",
        "The CLI executable could not be started.",
      );
    });
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    child.once("close", (code) => {
      options.onExit?.(code);
      options.signal.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
      terminate("SIGKILL");
      try {
        acceptText(decoder.end(), true);
      } catch (error) {
        failure = error;
      }
      if (failure) reject(failure);
      else if (
        code === null ||
        !(options.acceptedExitCodes ?? [0]).includes(code)
      )
        reject(
          options.classifyExit?.(
            code,
            Buffer.concat(diagnostic).toString("utf8"),
          ) ??
            new DriverError(
              "CLI_FAILED",
              "The CLI failed. Check its installed version, sign-in, and model access.",
            ),
        );
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    try {
      if (options.onStart)
        options.onStart(
          (data) => {
            if (!failure && !child.stdin.destroyed) child.stdin.write(data);
          },
          () => child.stdin.end(),
        );
      else child.stdin.end(options.input ?? "");
    } catch (error) {
      failure = error;
      stop();
    }
  });
}
