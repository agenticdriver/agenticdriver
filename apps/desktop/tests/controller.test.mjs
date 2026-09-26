import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { AgenticClient, connectionTarget } from "@agenticdriver/sdk/client";
import { desktopController } from "../src/controller.mjs";

const temporary = () => mkdtemp(join(tmpdir(), "agenticdriver-desktop-"));
const snapshot = (c) =>
  c.request({
    action: "panel",
    hostId: "local",
    request: { action: "snapshot" },
  });
const configure = async (c, provider, apiKey) =>
  c.request({
    action: "panel",
    hostId: "local",
    request: {
      action: "configure",
      change: {
        revision: (await snapshot(c)).management.revision,
        provider,
        ...(apiKey ? { apiKey } : {}),
      },
    },
  });
async function exchange(invitation) {
  const target = connectionTarget(invitation);
  const credentials = await new AgenticClient({
    url: target.url,
    token: target.code,
  }).exchangeConnection();
  return {
    client: new AgenticClient({ url: target.url, token: credentials.token }),
    credentials,
    url: target.url,
  };
}
async function files(path) {
  let result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const name = join(path, entry.name);
    result.push(...(entry.isDirectory() ? await files(name) : [name]));
  }
  return result;
}

test("desktop starts empty, preserves its port/providers/credentials, pairs scoped apps and revokes them", async () => {
  const directory = await temporary();
  let controller;
  try {
    controller = await desktopController(directory);
    const first = await controller.request({ action: "overview" });
    assert.equal(first.local.running, true);
    assert.equal(first.local.connections, 0);
    assert.deepEqual((await snapshot(controller)).providers, []);
    await assert.rejects(desktopController(directory), {
      code: "DESKTOP_BUSY",
    });
    await configure(controller, {
      kind: "mock",
      id: "offline",
      accountId: "synthetic",
    });
    const config = await snapshot(controller);
    assert.equal(config.management.providers[0].models, undefined);
    assert.deepEqual(config.management.executionProviders, []);
    const invite = await controller.request({
      action: "invite",
      hostId: "local",
      input: {
        grant: { subject: "synthetic-app", providers: ["offline"] },
        connectionLifetimeSeconds: 3600,
      },
    });
    const { client, credentials } = await exchange(invite.invitation);
    assert.equal(
      (
        await client.run({
          provider: "offline",
          model: "demo",
          input: "synthetic",
        })
      ).finishReason,
      "stop",
    );
    await assert.rejects(client.management(), { code: "FORBIDDEN" });
    const connections = await controller.request({
      action: "connections",
      hostId: "local",
    });
    assert.equal(connections.connections[0].activeRequests, 0);
    assert.ok(connections.connections[0].lastSeenAt);
    assert.equal(
      JSON.stringify(connections).includes(credentials.token),
      false,
    );
    const privateFiles = await files(directory);
    for (const path of privateFiles)
      assert.equal((await stat(path)).mode & 0o077, 0, path);
    await controller.close();
    controller = await desktopController(directory);
    assert.equal(
      (await controller.request({ action: "overview" })).local.url,
      first.local.url,
    );
    assert.equal(
      (await snapshot(controller)).management.providers[0].id,
      "offline",
    );
    assert.equal((await client.providers())[0].id, "offline");
    await controller.request({
      action: "revoke",
      hostId: "local",
      connectionId: credentials.id,
    });
    await assert.rejects(client.providers(), { code: "UNAUTHORIZED" });
    await controller.request({ action: "stop" });
    await assert.rejects(snapshot(controller), { code: "HOST_STOPPED" });
    await controller.request({ action: "start" });
    assert.equal(
      (await controller.request({ action: "overview" })).local.url,
      first.local.url,
    );
    await controller.request({ action: "startup", enabled: false });
    await controller.close();
    controller = await desktopController(directory);
    assert.equal(
      (await controller.request({ action: "overview" })).local.running,
      false,
    );
  } finally {
    await controller?.close({ interrupt: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("remote host profiles keep tokens private, persist selection, and respect manager/application grants", async () => {
  const directory = await temporary(),
    otherDirectory = await temporary();
  let first, second;
  try {
    first = await desktopController(directory);
    second = await desktopController(otherDirectory);
    await configure(first, { kind: "mock", id: "remote-offline" });
    const invitation = await first.request({
      action: "invite",
      hostId: "local",
      input: {
        grant: {
          subject: "other-desktop",
          providers: [],
          manageProviders: true,
        },
      },
    });
    const connected = await second.request({
      action: "connect",
      label: "Another desktop",
      invitation: invitation.invitation,
    });
    const hostId = connected.selectedHost;
    assert.notEqual(hostId, "local");
    const remote = await second.request({
      action: "panel",
      hostId,
      request: { action: "snapshot" },
    });
    assert.equal(remote.management.providers[0].id, "remote-offline");
    await second.request({
      action: "panel",
      hostId,
      request: {
        action: "configure",
        change: {
          revision: remote.management.revision,
          provider: { kind: "mock", id: "remote-offline", enabled: false },
        },
      },
    });
    assert.equal(
      (await snapshot(first)).management.providers[0].enabled,
      false,
    );
    const privateProfile = JSON.parse(
      await readFile(
        join(otherDirectory, "connections", hostId, "profile.json"),
        "utf8",
      ),
    );
    const token = (
      await readFile(
        join(otherDirectory, "connections", hostId, privateProfile.tokenFile),
        "utf8",
      )
    ).trim();
    assert.equal(JSON.stringify(connected).includes(token), false);
    assert.equal(JSON.stringify(remote).includes(token), false);
    await second.close();
    second = await desktopController(otherDirectory);
    assert.equal(
      (await second.request({ action: "overview" })).selectedHost,
      hostId,
    );
    await second.request({ action: "forget", hostId });
    await assert.rejects(
      second.request({
        action: "panel",
        hostId,
        request: { action: "snapshot" },
      }),
      { code: "HOST_NOT_FOUND" },
    );
    assert.equal(
      (await first.request({ action: "overview" })).local.running,
      true,
    );
    await assert.rejects(
      second.request({ action: "select", hostId: "../../outside" }),
      { code: "INVALID_DESKTOP_REQUEST" },
    );
    const bad = invitation.invitation.replace(
      /^ad1\.[^.]+/,
      "ad1." + Buffer.from("http://example.com").toString("base64url"),
    );
    await assert.rejects(
      second.request({ action: "connect", label: "Unsafe", invitation: bad }),
      { code: "INVALID_INVITATION" },
    );
  } finally {
    await first?.close({ interrupt: true });
    await second?.close({ interrupt: true });
    await rm(directory, { recursive: true, force: true });
    await rm(otherDirectory, { recursive: true, force: true });
  }
});

test("Usagestat display uses the SDK contract, preserves unknowns and never returns write-only tokens or arbitrary metadata", async () => {
  const directory = await temporary();
  const credential = "synthetic-service-token-do-not-display";
  let controller;
  const seen = [];
  const backend = createServer((req, res) => {
    seen.push({ url: req.url, token: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${credential}`) {
      res.writeHead(401).end();
      return;
    }
    const payload =
      req.url === "/v1/providers"
        ? [
            {
              id: "codex",
              displayName: "Codex",
              brandColor: "#74a98f",
              credential,
              icon: { kind: "file", path: "/private/logo.svg" },
            },
          ]
        : req.url === "/v1/usage"
          ? [
              {
                providerId: "codex",
                displayName: "Codex",
                fetchedAt: "2026-09-26T10:00:00Z",
                source: "synthetic",
                metrics: [
                  {
                    type: "tokens",
                    label: "Input tokens",
                    value: 120,
                    unit: "tokens",
                    secret: credential,
                  },
                ],
                credential,
              },
            ]
          : {
              schema: "crossusage.limits.v1",
              providers: {
                codex: {
                  displayName: "Codex",
                  fetchedAt: "2026-09-26T10:00:00Z",
                  resources: {
                    window: {
                      used: 12,
                      unit: "percent",
                      label: "Session usage",
                    },
                  },
                },
              },
              errors: [],
            };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(payload));
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  try {
    controller = await desktopController(directory, { autoStart: false });
    const url = `http://127.0.0.1:${backend.address().port}`;
    const settings = await controller.request({
      action: "usage-settings",
      url,
      token: credential,
    });
    assert.equal(settings.usage.hasToken, true);
    assert.equal(JSON.stringify(settings).includes(credential), false);
    const data = await controller.request({ action: "usage" });
    assert.equal(data.available, true);
    assert.equal(data.snapshots[0].metrics[0].value, 120);
    assert.equal(data.snapshots[0].metrics[0].limit, undefined);
    assert.equal(JSON.stringify(data).includes(credential), false);
    assert.equal(JSON.stringify(data).includes("/private/"), false);
    assert.deepEqual(
      new Set(seen.map((r) => r.url)),
      new Set(["/v1/providers", "/v1/usage"]),
    );
    assert.equal(
      (
        await controller.request({
          action: "usage-settings",
          url: url + "/other",
        })
      ).usage.hasToken,
      false,
    );
    await assert.rejects(
      controller.request({
        action: "usage-settings",
        url: "http://untrusted.example",
      }),
      { code: "INSECURE_TRANSPORT" },
    );
  } finally {
    await controller?.close();
    backend.closeAllConnections();
    await new Promise((resolve) => backend.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("host stop protects in-flight requests; explicit interruption closes only its owned stream", async () => {
  const directory = await temporary();
  let controller, response;
  let modelCalls = 0,
    signalModel;
  const modelStarted = new Promise((resolve) => {
    signalModel = resolve;
  });
  const backend = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "synthetic-model" }] }));
      return;
    }
    if (req.url === "/v1/chat/completions") {
      modelCalls++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        'data: {"choices":[{"index":0,"delta":{"content":"synthetic stream"}}]}\n\n',
      );
      signalModel();
      return;
    }
    res.writeHead(404).end();
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  try {
    controller = await desktopController(directory);
    const configured = await configure(
      controller,
      {
        kind: "openai-compatible",
        id: "synthetic-api",
        accountId: "synthetic-only",
        baseUrl: `http://127.0.0.1:${backend.address().port}/v1`,
        apiKeyRef: { env: "UNUSED_FIXTURE_KEY" },
      },
      "synthetic-not-a-provider-key",
    );
    assert.equal(
      JSON.stringify(configured).includes("synthetic-not-a-provider-key"),
      false,
    );
    const invitation = await controller.request({
      action: "invite",
      hostId: "local",
      input: {
        grant: { subject: "stream-test", providers: ["synthetic-api"] },
      },
    });
    const target = await exchange(invitation.invitation);
    response = await fetch(new URL("v1/runs", target.url), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${target.credentials.token}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        provider: "synthetic-api",
        model: "synthetic-model",
        input: "synthetic-only",
      }),
    });
    assert.equal(response.status, 200);
    await modelStarted;
    assert.equal(
      (await controller.request({ action: "overview" })).local.activeRequests,
      1,
    );
    await assert.rejects(controller.request({ action: "stop" }), {
      code: "HOST_BUSY",
    });
    await assert.rejects(controller.close(), { code: "HOST_BUSY" });
    // Catalog refresh and settings do not cancel or reroute the running stream.
    await controller.request({
      action: "panel",
      hostId: "local",
      request: { action: "snapshot", refresh: true },
    });
    assert.equal(
      (await controller.request({ action: "overview" })).local.activeRequests,
      1,
    );
    await controller.request({ action: "stop", interrupt: true });
    assert.equal(
      (await controller.request({ action: "overview" })).local.running,
      false,
    );
    assert.equal(modelCalls, 1);
  } finally {
    await response?.body?.cancel().catch(() => {});
    await controller?.close({ interrupt: true });
    backend.closeAllConnections();
    await new Promise((resolve) => backend.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
