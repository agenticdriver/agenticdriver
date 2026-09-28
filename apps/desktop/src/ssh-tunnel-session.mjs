/** One owned OpenSSH master. Losing the desktop worker's IPC closes the tunnel. */
import { spawn } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function sshEnvironment(source = process.env) {
  return Object.fromEntries(
    [
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "LANG",
      "LC_ALL",
      "SSH_AUTH_SOCK",
      "XDG_RUNTIME_DIR",
    ]
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, source[key]]),
  );
}

export function masterArguments(target, socket, configFile) {
  return [
    ...(configFile ? ["-F", configFile] : []),
    "-N",
    "-T",
    "-M",
    "-S",
    socket,
    ...Object.entries({
      BatchMode: "yes",
      StrictHostKeyChecking: "yes",
      UpdateHostKeys: "no",
      ControlPersist: "no",
      ClearAllForwardings: "yes",
      ExitOnForwardFailure: "yes",
      ForwardAgent: "no",
      ForwardX11: "no",
      PermitLocalCommand: "no",
      RemoteCommand: "none",
      RequestTTY: "no",
      ForkAfterAuthentication: "no",
      StdinNull: "yes",
      ConnectTimeout: "10",
      ConnectionAttempts: "1",
      ServerAliveInterval: "15",
      ServerAliveCountMax: "3",
    }).flatMap(([key, value]) => ["-o", `${key}=${value}`]),
    "--",
    target,
  ];
}

export function forwardArguments(target, socket, remotePort, localPort) {
  // This client only addresses our existing socket. No ambient configured
  // forwards, proxy commands or authentication are evaluated a second time.
  return [
    "-F",
    "none",
    "-S",
    socket,
    "-O",
    "forward",
    "-o",
    "ExitOnForwardFailure=yes",
    "-R",
    `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`,
    "--",
    target,
  ];
}

export function failureKind(diagnostics) {
  if (
    /host key verification failed|remote host identification has changed|no .* host key is known/i.test(
      diagnostics,
    )
  )
    return "trust";
  if (
    /permission denied|authentication failed|no supported authentication/i.test(
      diagnostics,
    )
  )
    return "authentication";
  if (
    /forwarding failed|cannot listen to port|port forwarding.*failed/i.test(
      diagnostics,
    )
  )
    return "forwarding";
  return "unavailable";
}

async function session() {
  const children = new Set();
  const abort = new AbortController();
  let directory,
    ending,
    started = false;
  const send = (value) => {
    if (process.connected) process.send(value);
  };
  function launch(args) {
    const child = spawn("/usr/bin/ssh", args, {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: sshEnvironment(),
    });
    const entry = { child, diagnostics: "", exited: false };
    entry.done = new Promise((resolve) => {
      child.once("error", () => {
        entry.exited = true;
        resolve(-1);
      });
      child.once("exit", (code) => {
        entry.exited = true;
        resolve(code ?? -1);
      });
    });
    child.stderr.on("data", (bytes) => {
      entry.diagnostics = (entry.diagnostics + bytes).slice(-8192);
    });
    children.add(entry);
    return entry;
  }
  async function terminate(entry) {
    const kill = (signal) => {
      if (!entry.child.pid) return;
      try {
        process.kill(-entry.child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    kill("SIGTERM");
    await Promise.race([entry.done, delay(1500)]);
    // Also collect proxy/jump children remaining in this owned process group.
    kill("SIGKILL");
    await entry.done;
    children.delete(entry);
  }
  async function close() {
    if (ending) return ending;
    abort.abort();
    ending = (async () => {
      await Promise.all([...children].map(terminate));
      if (directory) await rm(directory, { recursive: true, force: true });
      if (process.connected) process.disconnect();
    })();
    return ending;
  }
  process.on("disconnect", () => {
    void close().finally(() => process.exit());
  });
  process.on("SIGTERM", () => {
    void close().finally(() => process.exit());
  });
  process.on("SIGINT", () => {
    void close().finally(() => process.exit());
  });
  process.on("message", (message) => {
    if (message?.action === "stop") {
      void close();
      return;
    }
    if (message?.action !== "start" || started || ending) return;
    started = true;
    void (async () => {
      // Arguments are validated again here, including when this module is run directly.
      const { target, remotePort, localPort, configFile } = message;
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,199}$/.test(target ?? "") ||
        !Number.isInteger(remotePort) ||
        remotePort < 1024 ||
        remotePort > 65535 ||
        !Number.isInteger(localPort) ||
        localPort < 1 ||
        localPort > 65535 ||
        (configFile !== undefined &&
          (typeof configFile !== "string" || !configFile.startsWith("/")))
      )
        throw new Error("invalid");
      directory = await mkdtemp("/tmp/ad-ssh-");
      if (abort.signal.aborted) {
        await rm(directory, { recursive: true, force: true });
        throw new Error("stopped");
      }
      const socket = join(directory, "control");
      const master = launch(masterArguments(target, socket, configFile));
      const deadline = Date.now() + 15000;
      while (true) {
        if (abort.signal.aborted || master.exited)
          throw new Error(failureKind(master.diagnostics));
        if (Date.now() >= deadline) throw new Error("unavailable");
        try {
          if ((await lstat(socket)).isSocket()) break;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        await delay(50, undefined, { signal: abort.signal });
      }
      if (abort.signal.aborted) throw new Error("stopped");
      const forward = launch(
        forwardArguments(target, socket, remotePort, localPort),
      );
      const code = await Promise.race([
        forward.done,
        delay(10000).then(() => -1),
      ]);
      if (code !== 0 || master.exited || abort.signal.aborted)
        throw new Error(failureKind(forward.diagnostics + master.diagnostics));
      children.delete(forward); // Short-lived mux command completed; master owns the forward.
      send({ event: "ready" });
      await master.done;
      if (!abort.signal.aborted)
        send({ event: "failed", kind: "disconnected" });
    })()
      .catch((error) => {
        if (!abort.signal.aborted)
          send({
            event: "failed",
            kind: ["trust", "authentication", "forwarding"].includes(
              error.message,
            )
              ? error.message
              : "unavailable",
          });
      })
      .finally(() => close());
  });
  // A supervisor spawned but never initialized must not remain orphaned.
  const timer = setTimeout(() => {
    if (!started) void close();
  }, 5000);
  timer.unref();
}

if (process.argv[2] === "--ssh-session") await session();
