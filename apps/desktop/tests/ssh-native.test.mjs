import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgenticClient, connectionTarget } from "@agenticdriver/sdk/client";
import { desktopController } from "../src/controller.mjs";
import { managedTunnels } from "../src/ssh-tunnels.mjs";
import { sshEnvironment } from "../src/ssh-tunnel-session.mjs";
import { available, freePort, sshFixture, until } from "./ssh-fixture.mjs";

const enabled = await available();
if (process.env.AGENTICDRIVER_REQUIRE_SSH_TEST === "1" && !enabled)
  throw new Error(
    "This qualification job requires native OpenSSH client and server.",
  );
async function listening(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

test(
  "native SSH pairing, revocation, restart, host trust, port collision and owner cleanup",
  { skip: !enabled, timeout: 45000 },
  async () => {
    const fixture = await sshFixture();
    const directory = await mkdtemp(join(tmpdir(), "driver-managed-ssh-"));
    const supervisors = [];
    const tunnels = managedTunnels({
      configFile: fixture.configFile,
      launch: (...args) => {
        const child = fork(...args);
        supervisors.push(child);
        return child;
      },
    });
    let host;
    try {
      host = await desktopController(directory, { tunnels });
      let state = await host.request({ action: "overview" });
      assert.deepEqual(state.tunnels, []);
      const panel = await host.request({
        action: "panel",
        hostId: "local",
        request: { action: "snapshot" },
      });
      await host.request({
        action: "panel",
        hostId: "local",
        request: {
          action: "configure",
          change: {
            revision: panel.management.revision,
            provider: {
              kind: "mock",
              id: "ssh-fixture",
              accountId: "synthetic-only",
            },
          },
        },
      });
      const port = await freePort();
      const input = {
        label: "Application server",
        target: "synthetic",
        remotePort: port,
      };
      state = await host.request({ action: "create-tunnel", input });
      const tunnelId = state.tunnels[0].id;
      const destination = { mode: "managed-tunnel", tunnelId };
      assert.equal(state.tunnels[0].status, "stopped");
      await assert.rejects(host.request({ action: "create-tunnel", input }), {
        code: "TUNNEL_EXISTS",
      });
      await assert.rejects(
        host.request({
          action: "preview-destination",
          hostId: "local",
          destination,
        }),
        { code: "TUNNEL_NOT_RUNNING" },
      );
      for (const target of [
        "-oProxyCommand=bad",
        "server; touch /tmp/no",
        "server\nother",
        "user@$(command)",
      ]) {
        await assert.rejects(
          host.request({
            action: "create-tunnel",
            input: { ...input, target },
          }),
          { code: "INVALID_DESKTOP_REQUEST" },
        );
      }
      state = await host.request({ action: "start-tunnel", tunnelId });
      assert.equal(state.tunnels[0].status, "running");
      await assert.rejects(
        host.request({
          action: "update-tunnel",
          tunnelId,
          input: { ...input, remotePort: port === 65535 ? 1024 : port + 1 },
        }),
        { code: "TUNNEL_RUNNING" },
      );
      assert.equal(await listening(port), true);
      assert.equal(
        await listening(fixture.ambientPort),
        false,
        "Ambient LocalForward must not open a listener",
      );
      await assert.rejects(access(fixture.forbidden), { code: "ENOENT" });
      assert.equal(JSON.stringify(state).includes("control"), false);
      const preview = await host.request({
        action: "preview-destination",
        hostId: "local",
        destination,
      });
      assert.equal(preview.url, `http://127.0.0.1:${port}/`);
      assert.equal(preview.routeVerified, false);
      const invite = await host.request({
        action: "invite",
        hostId: "local",
        destination,
        input: {
          grant: { subject: "synthetic-remote", providers: ["ssh-fixture"] },
          connectionLifetimeSeconds: 60,
        },
      });
      const parsed = connectionTarget(invite.invitation);
      const exchange = new AgenticClient({
        url: parsed.url,
        token: parsed.code,
      });
      const grant = await exchange.exchangeConnection();
      const client = new AgenticClient({ url: parsed.url, token: grant.token });
      assert.equal((await client.protocol()).version, "1.0");
      assert.deepEqual(
        (await client.providers()).map((p) => p.id),
        ["ssh-fixture"],
      );
      await assert.rejects(exchange.exchangeConnection());
      await host.request({ action: "stop-tunnel", tunnelId });
      assert.equal(await listening(port), false);
      const updated = await host.request({
        action: "update-tunnel",
        tunnelId,
        input: { ...input, label: "Renamed server" },
      });
      assert.equal(updated.tunnels[0].id, tunnelId);
      assert.equal(updated.tunnels[0].label, "Renamed server");
      assert.equal(
        (await host.request({ action: "connections", hostId: "local" }))
          .connections.length,
        1,
      );
      await host.request({ action: "start-tunnel", tunnelId });
      assert.equal(
        (await client.protocol()).version,
        "1.0",
        "An existing grant works after explicit same-port restart",
      );
      const pending = httpRequest(new URL("v1/runs", parsed.url), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${grant.token}`,
          "Content-Type": "application/json",
          "AgenticDriver-Version": "1.0",
        },
      });
      pending.on("error", () => {});
      pending.write('{"provider":'); // An authenticated in-flight body; no inference.
      try {
        await until(
          async () =>
            (await host.request({ action: "overview" })).local.activeRequests >
            0,
        );
        await assert.rejects(
          host.request({ action: "stop-tunnel", tunnelId }),
          { code: "TUNNEL_BUSY" },
        );
        await assert.rejects(
          host.request({ action: "forget-tunnel", tunnelId }),
          { code: "TUNNEL_BUSY" },
        );
        await assert.rejects(host.close(), { code: "HOST_BUSY" });
        assert.equal(tunnels.snapshot(tunnelId).status, "running");
        await host.request({
          action: "stop-tunnel",
          tunnelId,
          interrupt: true,
        });
        await until(
          async () =>
            (await host.request({ action: "overview" })).local
              .activeRequests === 0,
        );
      } finally {
        pending.destroy();
      }
      await host.request({ action: "start-tunnel", tunnelId });
      supervisors.at(-1).disconnect(); // Simulate loss of the owning desktop worker.
      await until(() => tunnels.snapshot(tunnelId).status === "failed");
      assert.equal(await listening(port), false);
      await host.request({ action: "start-tunnel", tunnelId });
      await host.request({
        action: "revoke",
        hostId: "local",
        connectionId: grant.id,
      });
      await assert.rejects(client.protocol());
      await host.request({ action: "stop-tunnel", tunnelId });
      const known = await readFile(fixture.knownHosts);
      await writeFile(fixture.knownHosts, "");
      await assert.rejects(
        host.request({ action: "start-tunnel", tunnelId }),
        (error) =>
          error.code === "TUNNEL_FAILED" && error.message.includes("host key"),
      );
      assert.equal(await listening(port), false);
      const wrongKey = await readFile(
        join(fixture.directory, "identity.pub"),
        "utf8",
      );
      await writeFile(
        fixture.knownHosts,
        known
          .toString()
          .replace(
            /ssh-ed25519 [^ ]+/,
            wrongKey.trim().split(" ").slice(0, 2).join(" "),
          ),
      );
      await assert.rejects(
        host.request({ action: "start-tunnel", tunnelId }),
        (error) =>
          error.code === "TUNNEL_FAILED" && error.message.includes("host key"),
      );
      await writeFile(fixture.knownHosts, known);
      const authorizedFile = join(fixture.directory, "authorized-keys");
      const authorizedKey = await readFile(authorizedFile, "utf8");
      await writeFile(authorizedFile, "");
      await assert.rejects(
        host.request({ action: "start-tunnel", tunnelId }),
        (error) =>
          error.code === "TUNNEL_FAILED" && error.message.includes("sign in"),
      );
      await writeFile(authorizedFile, "restrict " + authorizedKey);
      await assert.rejects(
        host.request({ action: "start-tunnel", tunnelId }),
        (error) =>
          error.code === "TUNNEL_FAILED" &&
          error.message.includes("loopback port"),
      );
      await writeFile(authorizedFile, authorizedKey);
      const occupied = createServer((socket) => socket.destroy());
      occupied.listen(port, "127.0.0.1");
      await once(occupied, "listening");
      try {
        await assert.rejects(
          host.request({ action: "start-tunnel", tunnelId }),
          (error) =>
            error.code === "TUNNEL_FAILED" &&
            error.message.includes("loopback port"),
        );
      } finally {
        await new Promise((resolve) => occupied.close(resolve));
      }
      await host.request({ action: "start-tunnel", tunnelId });
      await host.request({ action: "stop" });
      assert.equal(await listening(port), false);
      assert.equal(
        (await host.request({ action: "overview" })).tunnels[0].status,
        "stopped",
      );
      await host.close();
      host = await desktopController(directory, {
        tunnels: managedTunnels({ configFile: fixture.configFile }),
      });
      assert.equal(
        (await host.request({ action: "overview" })).tunnels[0].status,
        "stopped",
        "Saved routes never auto-connect at launch",
      );
      await host.request({ action: "forget-tunnel", tunnelId });
      assert.deepEqual(
        (await host.request({ action: "overview" })).tunnels,
        [],
      );
    } finally {
      await host?.close({ interrupt: true });
      await tunnels.close();
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("SSH receives only its native identity environment, never provider credentials or preload hooks", () => {
  assert.deepEqual(
    sshEnvironment({
      HOME: "/private/home",
      PATH: "/bin",
      SSH_AUTH_SOCK: "/private/agent",
      OPENAI_API_KEY: "secret",
      NODE_OPTIONS: "preload",
      LD_PRELOAD: "inject",
      SSH_ASKPASS: "program",
    }),
    { PATH: "/bin", HOME: "/private/home", SSH_AUTH_SOCK: "/private/agent" },
  );
});
