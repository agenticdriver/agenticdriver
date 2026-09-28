import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DriverError } from "@agenticdriver/sdk/client";
import { sshEnvironment } from "./ssh-tunnel-session.mjs";

export const TunnelInputSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    target: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,199}$/),
    remotePort: z.number().int().min(1024).max(65535),
  })
  .strict();
export const TunnelSchema = TunnelInputSchema.extend({ id: z.uuid() }).strict();
const messages = {
  trust:
    "OpenSSH did not trust this server's host key. Verify the server in your terminal before starting this tunnel; AgenticDriver never accepts a new or changed key.",
  authentication:
    "OpenSSH could not sign in without a prompt. Set up this destination using your existing SSH key or agent in a terminal, then retry.",
  forwarding:
    "The server rejected this loopback port. Check its forwarding policy and whether the port is already in use, then retry.",
  unavailable:
    "The SSH tunnel could not start. Check OpenSSH, the saved SSH destination and network access in a terminal, then retry.",
  disconnected:
    "The SSH session ended. Check the network and server, then start this tunnel again. Existing connection grants were not revoked.",
};

/** Linux-only desktop facility. No SSH controls are added to the remote SDK API. */
export function managedTunnels({ configFile, launch = fork } = {}) {
  const sessions = new Map();
  const snapshot = (id) => {
    const entry = sessions.get(id);
    return entry
      ? {
          status: entry.status,
          changedAt: entry.changedAt,
          ...(entry.message ? { message: entry.message } : {}),
        }
      : { status: "stopped" };
  };
  async function stop(id) {
    const entry = sessions.get(id);
    if (!entry) return;
    entry.stopping = true;
    if (entry.child.connected) entry.child.send({ action: "stop" });
    await entry.done;
    entry.status = "stopped";
    entry.message = undefined;
    entry.changedAt = new Date().toISOString();
  }
  return {
    snapshot,
    async start(input, localPort) {
      const config = TunnelSchema.parse(input);
      if (process.platform !== "linux")
        throw new DriverError(
          "TUNNEL_UNSUPPORTED",
          "Managed SSH tunnels are currently qualified on Linux. Use the manual SSH instructions on other systems.",
        );
      if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535)
        throw new DriverError(
          "HOST_STOPPED",
          "Start the local host before starting its tunnel.",
        );
      if (["running", "starting"].includes(snapshot(config.id).status))
        return snapshot(config.id);
      await stop(config.id);
      const child = launch(
        fileURLToPath(new URL("./ssh-tunnel-session.mjs", import.meta.url)),
        ["--ssh-session"],
        {
          // Keep the cleanup supervisor outside the desktop's process group so
          // a crashed/terminated owner group still closes SSH through IPC EOF.
          detached: true,
          execArgv: [],
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          env: sshEnvironment(),
        },
      );
      const entry = {
        child,
        status: "starting",
        changedAt: new Date().toISOString(),
        stopping: false,
      };
      sessions.set(config.id, entry);
      let settle;
      const ready = new Promise((resolve, reject) => {
        settle = { resolve, reject };
      });
      const failed = (kind) => {
        if (entry.stopping) {
          settle.reject(
            new DriverError("TUNNEL_STOPPED", "The SSH tunnel was stopped."),
          );
          return;
        }
        entry.status = "failed";
        entry.changedAt = new Date().toISOString();
        entry.message = messages[kind] ?? messages.unavailable;
        settle.reject(new DriverError("TUNNEL_FAILED", entry.message));
      };
      entry.done = new Promise((resolve) => {
        child.once("error", () => {
          failed("unavailable");
          resolve();
        });
        child.once("exit", () => {
          if (entry.status !== "failed") failed("disconnected");
          resolve();
        });
      });
      child.on("message", (message) => {
        if (message?.event === "ready" && !entry.stopping) {
          entry.status = "running";
          entry.changedAt = new Date().toISOString();
          settle.resolve();
        } else if (message?.event === "failed") failed(message.kind);
      });
      child.send(
        {
          action: "start",
          target: config.target,
          remotePort: config.remotePort,
          localPort,
          ...(configFile ? { configFile } : {}),
        },
        (error) => {
          if (error) failed("unavailable");
        },
      );
      try {
        await ready;
      } catch (error) {
        await entry.done;
        throw error;
      }
      return snapshot(config.id);
    },
    stop,
    async forget(id) {
      await stop(id);
      sessions.delete(id);
    },
    async close() {
      await Promise.all([...sessions.keys()].map(stop));
    },
  };
}
