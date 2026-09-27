import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as httpsServer } from "node:https";
import { request as httpRequest } from "node:http";
import { createServer as tcpServer, connect as tcpConnect } from "node:net";
import { connectionTarget } from "@agenticdriver/sdk/client";
import { desktopController } from "../src/controller.mjs";
import { createTlsFixture } from "../../../tests/tls-fixture.ts";

const temporary = () => mkdtemp(join(tmpdir(), "driver-destination-"));
const input = {
  grant: {
    subject: "destination-fixture",
    providers: [],
    manageProviders: true,
  },
};
const invitation = (controller, destination) =>
  controller.request({ action: "invite", hostId: "local", input, destination });

test("destination preview is metadata-only; insecure addresses fail before a grant is issued", async () => {
  const directory = await temporary();
  const controller = await desktopController(directory);
  try {
    const preview = (destination) =>
      controller.request({
        action: "preview-destination",
        hostId: "local",
        destination,
      });
    const overview = await controller.request({ action: "overview" });
    assert.equal(
      (await preview({ mode: "current" })).url,
      overview.local.url + "/",
    );
    const remote = await preview({
      mode: "https",
      url: "https://driver.example.test/proxy",
    });
    assert.equal(remote.url, "https://driver.example.test/proxy/");
    assert.equal(remote.routeVerified, false);
    for (const url of [
      "http://192.0.2.10:7433",
      "http://127.0.0.1:7433",
      "https://user:secret@driver.example.test",
      "https://driver.example.test/?secret=value",
      "https://driver.example.test/#code",
      "file:///tmp/driver",
    ]) {
      await assert.rejects(invitation(controller, { mode: "https", url }));
    }
    const tunnel = await preview({ mode: "tunnel", port: 17433 });
    assert.equal(tunnel.url, "http://127.0.0.1:17433/");
    const hostPort = new URL(overview.local.url).port;
    assert.equal(
      tunnel.commands.fromApplication,
      `ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:17433:127.0.0.1:${hostPort} USER@DRIVER_HOST`,
    );
    assert.equal(
      tunnel.commands.fromHost,
      `ssh -N -o ExitOnForwardFailure=yes -R 127.0.0.1:17433:127.0.0.1:${hostPort} USER@APP_SERVER`,
    );
    for (const port of [0, 22, 65536, 17433.5])
      await assert.rejects(invitation(controller, { mode: "tunnel", port }), {
        code: "INVALID_DESKTOP_REQUEST",
      });
    const grants = await controller.request({
      action: "connections",
      hostId: "local",
    });
    assert.equal(grants.invitations.length, 0);
    assert.equal(grants.connections.length, 0);
    await controller.request({ action: "stop" });
    await assert.rejects(invitation(controller, { mode: "current" }), {
      code: "HOST_STOPPED",
    });
  } finally {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("application-side loopback forwarding exchanges and reconnects without changing the host listener", async () => {
  const directory = await temporary(),
    appDirectory = await temporary();
  const host = await desktopController(directory);
  const app = await desktopController(appDirectory, { autoStart: false });
  const hostUrl = (await host.request({ action: "overview" })).local.url;
  // The TCP fixture represents an established SSH-forwarded listener; it does not certify SSH itself.
  const sockets = new Set();
  const forward = tcpServer((socket) => {
    const upstream = tcpConnect({
      host: "127.0.0.1",
      port: Number(new URL(hostUrl).port),
    });
    for (const stream of [socket, upstream]) {
      sockets.add(stream);
      stream.on("close", () => sockets.delete(stream));
      stream.on("error", () => {
        socket.destroy();
        upstream.destroy();
      });
    }
    socket.pipe(upstream).pipe(socket);
  });
  forward.listen(0, "127.0.0.1");
  await once(forward, "listening");
  try {
    const destination = { mode: "tunnel", port: forward.address().port };
    const first = await invitation(host, destination);
    const connected = await app.request({
      action: "connect",
      label: "Forwarded host",
      invitation: first.invitation,
    });
    assert.equal(connected.hosts[0].url, first.destination.url);
    assert.equal(connected.hosts[0].check.status, "connected");
    const hostId = connected.selectedHost;
    await assert.rejects(
      app.request({ action: "preview-destination", hostId, destination }),
      { code: "TUNNEL_HOST_REQUIRED" },
    );
    const second = await invitation(host, destination);
    const replaced = await app.request({
      action: "reconnect",
      hostId,
      invitation: second.invitation,
    });
    assert.equal(replaced.selectedHost, hostId);
    assert.equal(replaced.hosts[0].check.status, "connected");
    assert.equal(
      (await host.request({ action: "overview" })).local.url,
      hostUrl,
    );
  } finally {
    await app.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => forward.close(resolve));
    await host.close();
    await Promise.all(
      [directory, appDirectory].map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
    );
  }
});

test("HTTPS proxy invitations keep path prefixes and verify a private CA without sending operator credentials to the proxy", async () => {
  const directory = await temporary();
  const tls = await createTlsFixture(directory);
  const host = await desktopController(join(directory, "host"));
  const hostUrl = (await host.request({ action: "overview" })).local.url;
  const operator = (
    await readFile(join(directory, "host/local/operator.token"), "utf8")
  ).trim();
  const seen = [];
  const proxy = httpsServer(
    { cert: await readFile(tls.cert), key: await readFile(tls.key) },
    (req, res) => {
      seen.push({
        path: req.url,
        operator: req.headers.authorization === `Bearer ${operator}`,
      });
      if (!req.url.startsWith("/driver/")) {
        res.writeHead(404).end();
        return;
      }
      const upstream = httpRequest(
        new URL(req.url.slice("/driver/".length), hostUrl + "/"),
        { method: req.method, headers: req.headers },
        (response) => {
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
        },
      );
      upstream.on("error", () => res.destroy());
      req.pipe(upstream);
    },
  );
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  let untrusted;
  try {
    const url = `https://127.0.0.1:${proxy.address().port}/driver`;
    const destination = { mode: "https", url };
    const first = await invitation(host, destination);
    const second = await invitation(host, destination);
    assert.equal(seen.length, 0);
    assert.equal(connectionTarget(first.invitation).url, url + "/");
    untrusted = await desktopController(join(directory, "untrusted"), {
      autoStart: false,
    });
    await assert.rejects(
      untrusted.request({
        action: "connect",
        label: "Untrusted",
        invitation: first.invitation,
      }),
    );
    assert.equal(seen.length, 0);
    assert.equal(
      (await host.request({ action: "connections", hostId: "local" }))
        .invitations.length,
      2,
    );
    const payload = join(directory, "invitations.json");
    await writeFile(
      payload,
      JSON.stringify([first.invitation, second.invitation]),
      { mode: 0o600 },
    );
    const controllerUrl = new URL("../src/controller.mjs", import.meta.url)
      .href;
    const script = `
      import assert from 'node:assert/strict';
      import { readFile } from 'node:fs/promises';
      import { connectionInvitation, connectionTarget } from '@agenticdriver/sdk/client';
      import { desktopController } from ${JSON.stringify(controllerUrl)};
      const [first, second] = JSON.parse(await readFile(process.argv[1], 'utf8'));
      const app = await desktopController(process.argv[2], { autoStart: false });
      try {
        const target = connectionTarget(first);
        await assert.rejects(app.request({ action: 'connect', label: 'Wrong hostname', invitation: connectionInvitation(target.url.replace('127.0.0.1', 'localhost'), target.code) }), (error) => error.cause?.code === 'ERR_TLS_CERT_ALTNAME_INVALID');
        const saved = await app.request({ action: 'connect', label: 'Verified TLS proxy', invitation: first });
        assert.equal(saved.hosts[0].check.status, 'connected');
        const hostId = saved.selectedHost;
        const next = await app.request({ action: 'reconnect', hostId, invitation: second });
        assert.equal(next.selectedHost, hostId);
        assert.equal(next.hosts[0].check.status, 'connected');
        assert.equal((await app.request({ action: 'panel', hostId, request: { action: 'snapshot' } })).connected, true);
        console.log('verified TLS pairing and reconnection passed');
      } catch (error) {
        console.error(error.code ?? error.cause?.code ?? 'TLS_FIXTURE_FAILED');
        process.exitCode = 1;
      } finally { await app.close(); }
    `;
    const result = await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        script,
        payload,
        join(directory, "trusted"),
      ],
      {
        env: {
          ...process.env,
          NODE_EXTRA_CA_CERTS: tls.ca,
          NODE_OPTIONS: undefined,
          NODE_TLS_REJECT_UNAUTHORIZED: undefined,
        },
        timeout: 15000,
        maxBuffer: 10000,
      },
    );
    assert.match(result.stdout, /verified TLS pairing and reconnection passed/);
    assert.ok(
      seen.some(
        (request) => request.path === "/driver/v1/connections/exchange",
      ),
    );
    assert.ok(seen.some((request) => request.path === "/driver/v1/protocol"));
    assert.ok(
      seen.every(
        (request) =>
          request.path.startsWith("/driver/v1/") && !request.operator,
      ),
    );
    assert.equal(
      seen.some((request) => request.path.includes("/runs")),
      false,
    );
  } finally {
    await untrusted?.close();
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
    await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});
