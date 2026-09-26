import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
export function startWorker(directory, executable) {
  const child = fork(
    fileURLToPath(new URL("./worker.mjs", import.meta.url)),
    [directory],
    {
      execPath: executable,
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      // Host credentials are resolved from private files inside the worker, never passed in arguments.
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        NODE_OPTIONS: undefined,
        NODE_PATH: undefined,
      },
    },
  );
  const pending = new Map();
  let alive = true,
    resolveReady,
    rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const error = (details) =>
    Object.assign(new Error(details.message), { code: details.code });
  child.on("message", (message) => {
    if (message.event === "ready") {
      resolveReady();
      return;
    }
    if (message.event === "failed") {
      rejectReady(error(message.error));
      return;
    }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    message.error
      ? item.reject(error(message.error))
      : item.resolve(message.value);
  });
  const ended = () => {
    alive = false;
    const failure = new Error(
      "The desktop host process stopped. Reopen the app to recover the saved profile.",
    );
    rejectReady(failure);
    for (const item of pending.values()) item.reject(failure);
    pending.clear();
  };
  child.once("exit", ended);
  child.once("error", ended);
  function call(message) {
    if (!alive || !child.connected)
      return Promise.reject(
        new Error("The desktop host process is unavailable."),
      );
    if (pending.size >= 32)
      return Promise.reject(
        new Error("Wait for the current operation to finish."),
      );
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      pending.set(id, { resolve, reject });
      child.send({ id, ...message }, (err) => {
        if (err) {
          pending.delete(id);
          reject(new Error("The desktop host process is unavailable."));
        }
      });
    });
  }
  return {
    ready,
    request: (input) => call({ input }),
    close: (interrupt) => call({ close: true, interrupt }),
    child,
  };
}
