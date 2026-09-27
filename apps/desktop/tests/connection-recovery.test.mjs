import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgenticClient,
  connectionInvitation,
  connectionTarget,
} from "@agenticdriver/sdk/client";
import { connectedClient } from "@agenticdriver/sdk/connections";
import { desktopController } from "../src/controller.mjs";
import { connectionFailure } from "../src/connection-status.mjs";

const temp = () => mkdtemp(join(tmpdir(), "driver-connection-recovery-"));
const panel = (controller, hostId = "local") =>
  controller.request({
    action: "panel",
    hostId,
    request: { action: "snapshot" },
  });
const invite = (controller, manageProviders = true) =>
  controller.request({
    action: "invite",
    hostId: "local",
    input: {
      grant: { subject: "synthetic-desktop", providers: [], manageProviders },
    },
  });

test("invitation preview never contacts its destination or exposes the one-use credential; checks only read the authenticated protocol", async () => {
  const directory = await temp();
  const code = "A".repeat(43),
    token = "B".repeat(43);
  const seen = [];
  let protocolMode = "ready",
    controller;
  const backend = createServer((req, res) => {
    seen.push({
      path: req.url,
      method: req.method,
      auth: req.headers.authorization,
    });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/proxy/v1/connections/exchange") {
      assert.equal(req.headers.authorization, `Bearer ${code}`);
      res.end(
        JSON.stringify({
          id: randomUUID(),
          token,
          grant: { subject: "synthetic", providers: [] },
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        }),
      );
    } else if (req.url === "/proxy/v1/protocol") {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      if (protocolMode === "rejected") {
        res.writeHead(401).end(
          JSON.stringify({
            error: {
              code: "UNAUTHORIZED",
              message: "do-not-expose-upstream-secret",
              retryable: false,
            },
          }),
        );
      } else if (protocolMode === "incompatible") {
        res.end(JSON.stringify({ protocol: "other" }));
      } else {
        res.end(
          JSON.stringify({
            protocol: "agenticdriver",
            version: "1.0",
            supportedVersions: ["1.0"],
            features: ["client-pairing"],
          }),
        );
      }
    } else {
      res.writeHead(500).end();
    }
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  const url = `http://127.0.0.1:${backend.address().port}/proxy/`;
  try {
    controller = await desktopController(directory, { autoStart: false });
    const invitation = connectionInvitation(url, code);
    const preview = await controller.request({
      action: "preview-invitation",
      invitation,
    });
    assert.equal(preview.url, url);
    assert.equal(preview.location, "this-computer");
    assert.equal(preview.transport, "loopback");
    assert.equal(JSON.stringify(preview).includes(code), false);
    assert.equal(seen.length, 0);
    const remotePreview = await controller.request({
      action: "preview-invitation",
      invitation: connectionInvitation(
        "https://driver.example.test/host/",
        code,
      ),
    });
    assert.equal(remotePreview.location, "remote");
    assert.equal(seen.length, 0);
    const state = await controller.request({
      action: "connect",
      invitation,
      label: "Synthetic proxy",
    });
    const hostId = state.selectedHost;
    assert.equal(state.hosts[0].check.status, "connected");
    assert.equal(state.hosts[0].check.canManageProviders, false);
    seen.length = 0;
    assert.equal(
      (await controller.request({ action: "check-host", hostId })).status,
      "connected",
    );
    assert.deepEqual(
      seen.map(({ path, method }) => ({ path, method })),
      [{ path: "/proxy/v1/protocol", method: "GET" }],
    );
    protocolMode = "rejected";
    const rejected = await controller.request({ action: "check-host", hostId });
    assert.equal(rejected.status, "rejected");
    assert.equal(JSON.stringify(rejected).includes("do-not-expose"), false);
    protocolMode = "incompatible";
    assert.equal(
      (await controller.request({ action: "check-host", hostId })).status,
      "incompatible",
    );
    backend.closeAllConnections();
    await new Promise((resolve) => backend.close(resolve));
    assert.equal(
      (await controller.request({ action: "check-host", hostId })).status,
      "unreachable",
    );
    assert.equal(
      JSON.stringify(await controller.request({ action: "overview" })).includes(
        token,
      ),
      false,
    );
    await assert.rejects(
      controller.request({ action: "check-host", hostId: randomUUID() }),
      { code: "HOST_NOT_FOUND" },
    );
  } finally {
    await controller?.close();
    backend.closeAllConnections();
    if (backend.listening)
      await new Promise((resolve) => backend.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("expired and revoked remote connections recover without losing host identity, label or previous private profiles", async () => {
  const hostDirectory = await temp(),
    appDirectory = await temp();
  let host, app;
  try {
    host = await desktopController(hostDirectory);
    app = await desktopController(appDirectory, { autoStart: false });
    const initial = await app.request({
      action: "connect",
      label: "Original name",
      invitation: (await invite(host)).invitation,
    });
    const hostId = initial.selectedHost;
    const profilePath = join(
      appDirectory,
      "connections",
      hostId,
      "profile.json",
    );
    const originalBytes = await readFile(profilePath);
    const original = JSON.parse(originalBytes);
    const oldClient = await connectedClient(profilePath);
    const token = await readFile(
      join(appDirectory, "connections", hostId, original.tokenFile),
    );
    await app.request({
      action: "rename-host",
      hostId,
      label: "My workstation",
    });
    await writeFile(
      profilePath,
      JSON.stringify({ ...original, expiresAt: "2000-01-01T00:00:00.000Z" }),
    );
    assert.equal(
      (await app.request({ action: "check-host", hostId })).status,
      "expired",
    );
    const expired = await panel(app, hostId);
    assert.equal(expired.connected, false);
    assert.deepEqual(expired.providers, []);
    assert.match(expired.connectionError, /expired/);
    await writeFile(profilePath, originalBytes);

    const replacement = await invite(host, false);
    const target = connectionTarget(replacement.invitation);
    const wrongAddress = connectionInvitation(
      target.url.replace("127.0.0.1", "localhost"),
      target.code,
    );
    await assert.rejects(
      app.request({ action: "reconnect", hostId, invitation: wrongAddress }),
      { code: "HOST_ADDRESS_MISMATCH" },
    );
    assert.equal(
      (await host.request({ action: "connections", hostId: "local" }))
        .invitations.length,
      1,
    );
    await assert.rejects(
      app.request({
        action: "reconnect",
        hostId,
        invitation: connectionInvitation(target.url, "X".repeat(43)),
      }),
      { code: "INVITATION_REJECTED" },
    );
    assert.deepEqual(await readFile(profilePath), originalBytes);
    assert.equal((await panel(app, hostId)).management !== undefined, true);

    const reconnected = await app.request({
      action: "reconnect",
      hostId,
      invitation: replacement.invitation,
    });
    assert.equal(reconnected.selectedHost, hostId);
    assert.equal(reconnected.hosts.length, 1);
    assert.equal(reconnected.hosts[0].label, "My workstation");
    assert.equal(reconnected.hosts[0].check.status, "connected");
    assert.equal(reconnected.hosts[0].check.canManageProviders, false);
    assert.equal(JSON.stringify(reconnected).includes("profileFile"), false);
    assert.deepEqual(await readFile(profilePath), originalBytes);
    assert.deepEqual(
      await readFile(
        join(appDirectory, "connections", hostId, original.tokenFile),
      ),
      token,
    );
    assert.equal(
      (await oldClient.protocol()).features.includes("provider-management"),
      true,
    );
    assert.equal((await panel(app, hostId)).management, undefined);
    const settings = JSON.parse(
      await readFile(join(appDirectory, "settings.json"), "utf8"),
    );
    const newProfile = JSON.parse(
      await readFile(
        join(
          appDirectory,
          "connections",
          hostId,
          settings.hosts[0].profileFile,
        ),
        "utf8",
      ),
    );
    assert.notEqual(newProfile.id, original.id);
    assert.notEqual(newProfile.tokenFile, original.tokenFile);
    assert.equal(
      (await host.request({ action: "connections", hostId: "local" }))
        .connections.length,
      2,
    );
    await app.close();
    app = await desktopController(appDirectory, { autoStart: false });
    assert.equal(
      (await app.request({ action: "overview" })).selectedHost,
      hostId,
    );
    assert.equal(
      (await app.request({ action: "check-host", hostId })).status,
      "connected",
    );
    await host.request({
      action: "revoke",
      hostId: "local",
      connectionId: newProfile.id,
    });
    assert.equal(
      (await app.request({ action: "check-host", hostId })).status,
      "rejected",
    );
    assert.equal((await panel(app, hostId)).connected, false);
    assert.equal(
      (
        await app.request({
          action: "reconnect",
          hostId,
          invitation: (await invite(host)).invitation,
        })
      ).hosts[0].check.status,
      "connected",
    );
    await app.request({ action: "forget", hostId });
    await assert.rejects(readFile(profilePath), { code: "ENOENT" });
    assert.equal(
      (await host.request({ action: "overview" })).local.running,
      true,
    );
  } finally {
    await app?.close({ interrupt: true });
    await host?.close({ interrupt: true });
    await rm(appDirectory, { recursive: true, force: true });
    await rm(hostDirectory, { recursive: true, force: true });
  }
});

test("a failed host-list save after reconnect keeps the old connection usable and never repeats the exchange", async () => {
  const hostDirectory = await temp(),
    appDirectory = await temp();
  let host, app;
  try {
    host = await desktopController(hostDirectory);
    app = await desktopController(appDirectory, { autoStart: false });
    const initial = await app.request({
      action: "connect",
      label: "Preserve me",
      invitation: (await invite(host)).invitation,
    });
    const hostId = initial.selectedHost;
    const settings = join(appDirectory, "settings.json"),
      backup = settings + ".backup";
    const bytes = await readFile(settings);
    await rename(settings, backup);
    await mkdir(settings, { mode: 0o700 });
    await assert.rejects(
      app.request({
        action: "reconnect",
        hostId,
        invitation: (await invite(host, false)).invitation,
      }),
      { code: "HOST_SAVE_FAILED" },
    );
    assert.equal((await panel(app, hostId)).management !== undefined, true);
    assert.equal(
      (await host.request({ action: "connections", hostId: "local" }))
        .invitations.length,
      0,
    );
    assert.equal(
      (await host.request({ action: "connections", hostId: "local" }))
        .connections.length,
      2,
    );
    assert.equal(
      (await app.request({ action: "overview" })).hosts[0].label,
      "Preserve me",
    );
    assert.equal(
      (await readdir(join(appDirectory, "connections", hostId))).filter(
        (name) => name.endsWith(".json"),
      ).length,
      2,
    );
    await rm(settings, { recursive: true });
    await rename(backup, settings);
    assert.deepEqual(await readFile(settings), bytes);
  } finally {
    await app?.close({ interrupt: true });
    await host?.close({ interrupt: true });
    await rm(appDirectory, { recursive: true, force: true });
    await rm(hostDirectory, { recursive: true, force: true });
  }
});

test("connection diagnostics classify certificate and timeout failures without returning native error contents", () => {
  for (const code of [
    "CERT_HAS_EXPIRED",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "ERR_TLS_CERT_ALTNAME_INVALID",
  ]) {
    const status = connectionFailure(
      new TypeError("private URL and token", {
        cause: Object.assign(new Error("secret"), { code }),
      }),
    );
    assert.equal(status.status, "certificate");
    assert.equal(JSON.stringify(status).includes("secret"), false);
    assert.match(status.message, /verification remains enabled/);
  }
  assert.equal(
    connectionFailure(new DOMException("secret", "TimeoutError")).status,
    "unreachable",
  );
});
