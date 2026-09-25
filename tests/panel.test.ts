import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import { AgenticClient, connectionInvitation } from "../src/client.js";
import { managedHost } from "../src/management.js";
import { configuredServer } from "../src/host.js";
import { withConnections } from "../src/connections.js";
import { serve } from "../src/server.js";
import { providerPanel, type ProviderPanelState } from "../src/panel.js";
import { providerPanelHtml } from "../src/ui.js";
import { serveProviderPanel } from "../src/panel-server.js";

const credential = "fixture-operator-private-credential-at-least-32-characters";
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "driver-panel-"));
  const config = join(directory, "host.json");
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      usage: { hostId: "panel-fixture" },
      listen: { port: 0 },
      providers: [
        { id: "all", kind: "mock" },
        { id: "denied", kind: "mock", models: [] },
      ],
      tokens: [
        {
          id: "operator",
          subject: "operator",
          providers: [],
          manageProviders: true,
          tokenRef: { env: "PANEL_FIXTURE" },
        },
      ],
    }),
    { mode: 0o600 },
  );
  const host = await managedHost(config);
  const server = await serve(
    host.driver,
    withConnections(
      {
        ...(await configuredServer(
          host.config(),
          config,
          async () => credential,
        )),
        management: host.management,
      },
      host.connections,
    ),
  );
  return {
    directory,
    host,
    server,
    client: new AgenticClient({ url: server.url, token: credential }),
    async close() {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("provider panel preserves discovery versus execution, explicit management, revision conflicts and private credentials", async () => {
  const f = await fixture();
  try {
    const panel = providerPanel({
      client: () => f.client,
      connection: () => ({
        id: "operator",
        label: "Fixture host",
        url: f.server.url,
      }),
    });
    const state = (await panel({
      action: "snapshot",
      refresh: true,
    })) as ProviderPanelState;
    assert.equal(state.connected, true);
    assert.equal(state.canInvite, true);
    assert.equal(
      state.providers.find((p) => p.id === "all")!.models,
      undefined,
    );
    assert.deepEqual(
      state.providers.find((p) => p.id === "denied")!.models,
      [],
    );
    assert.deepEqual(state.management!.executionProviders, []);
    assert.ok(!JSON.stringify(state).includes(credential));
    const changed = (await panel({
      action: "configure",
      change: {
        revision: state.management!.revision,
        provider: {
          id: "denied",
          kind: "mock",
          name: "Updated remotely",
          models: [],
        },
      },
    })) as ProviderPanelState;
    assert.equal(
      changed.providers.find((p) => p.id === "denied")!.name,
      "Updated remotely",
    );
    await assert.rejects(
      panel({
        action: "configure",
        change: {
          revision: state.management!.revision,
          provider: { id: "denied", kind: "mock" },
        },
      }),
      { code: "CONFIG_CONFLICT" },
    );
    const invitation = await f.client.createInvitation({
      grant: { subject: "read-only-panel", providers: ["denied"] },
    });
    const grant = await new AgenticClient({
      url: f.server.url,
      token: invitation.code,
    }).exchangeConnection();
    const readonly = providerPanel({
      client: () =>
        new AgenticClient({ url: f.server.url, token: grant.token }),
    });
    const limited = (await readonly({
      action: "snapshot",
    })) as ProviderPanelState;
    assert.equal(limited.management, undefined);
    assert.equal(limited.canInvite, false);
    assert.deepEqual(
      limited.providers.map((p) => p.id),
      ["denied"],
    );
    await assert.rejects(
      readonly({
        action: "configure",
        change: {
          revision: changed.management!.revision,
          provider: { id: "denied", kind: "mock" },
        },
      }),
      { code: "FORBIDDEN" },
    );
  } finally {
    await f.close();
  }
});

test("standalone component pairs once, reloads a private profile, rejects other browser origins, and forgets an expired connection", async () => {
  const f = await fixture();
  const profile = join(f.directory, "client", "profile.json");
  let panel = await serveProviderPanel({
    connectionPath: profile,
    port: 0,
    script: "// fixture asset",
  });
  const call = async (action: unknown, origin = panel.url) =>
    fetch(panel.url + "/api/agenticdriver-panel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        Authorization:
          "Bearer " + new URL(panel.launchUrl).hash.slice("#panel=".length),
      },
      body: JSON.stringify(action),
    });
  try {
    assert.equal(
      (
        await fetch(panel.url + "/api/agenticdriver-panel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"action":"snapshot"}',
        })
      ).status,
      401,
    );
    assert.ok(
      !(
        await (await fetch(panel.url + "/assets/panel-session.js")).text()
      ).includes(new URL(panel.launchUrl).hash.slice(7)),
    );
    const disconnected = (await (
      await call({ action: "snapshot" })
    ).json()) as ProviderPanelState;
    assert.equal(disconnected.connected, false);
    assert.equal(disconnected.canConnect, true);
    assert.equal(
      (await call({ action: "snapshot" }, "https://untrusted.example")).status,
      403,
    );
    assert.equal(
      (
        await fetch(panel.url + "/api/agenticdriver-panel", {
          method: "POST",
          headers: {
            "Content-Type": "text/plain",
            Authorization:
              "Bearer " + new URL(panel.launchUrl).hash.slice("#panel=".length),
          },
          body: "{}",
        })
      ).status,
      400,
    );
    assert.equal(
      await new Promise<number | undefined>((resolve, reject) => {
        get(
          panel.url,
          { headers: { Host: "untrusted.example" } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        ).on("error", reject);
      }),
      403,
    );
    const page = await fetch(panel.url);
    assert.match(
      page.headers.get("content-security-policy")!,
      /frame-ancestors 'none'/,
    );
    assert.match(await page.text(), /agenticdriver-providers/);
    assert.equal(
      await (await fetch(panel.url + "/assets/agenticdriver-panel.js")).text(),
      "// fixture asset",
    );
    const invite = await f.client.createInvitation({
      grant: { subject: "panel-user", providers: [], manageProviders: true },
    });
    const connected = (await (
      await call({
        action: "connect",
        invitation: connectionInvitation(f.server.url, invite.code),
      })
    ).json()) as ProviderPanelState;
    assert.equal(connected.connected, true);
    assert.equal(connected.management!.providers.length, 2);
    const privateProfile = JSON.parse(await readFile(profile, "utf8"));
    const token = (
      await readFile(
        join(f.directory, "client", privateProfile.tokenFile),
        "utf8",
      )
    ).trim();
    assert.ok(!JSON.stringify(connected).includes(token));
    const oldPanelKey = new URL(panel.launchUrl).hash.slice(7);
    await panel.close();
    panel = await serveProviderPanel({
      connectionPath: profile,
      port: 0,
      script: "// fixture asset",
    });
    assert.equal(
      (
        (await (
          await call({ action: "snapshot" })
        ).json()) as ProviderPanelState
      ).connected,
      true,
    );
    assert.equal(
      (
        await fetch(panel.url + "/api/agenticdriver-panel", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + oldPanelKey,
          },
          body: JSON.stringify({ action: "snapshot" }),
        })
      ).status,
      401,
    );
    await writeFile(
      profile,
      JSON.stringify({
        ...privateProfile,
        expiresAt: "2020-01-01T00:00:00.000Z",
      }),
    );
    const expired = (await (
      await call({ action: "snapshot" })
    ).json()) as ProviderPanelState;
    assert.equal(expired.connected, false);
    assert.equal(expired.connection!.id, privateProfile.id);
    assert.equal(expired.canDisconnect, true);
    assert.equal(
      (
        (await (
          await call({ action: "disconnect" })
        ).json()) as ProviderPanelState
      ).connected,
      false,
    );
    await assert.rejects(readFile(profile), { code: "ENOENT" });
    await assert.rejects(
      readFile(join(f.directory, "client", privateProfile.tokenFile)),
      { code: "ENOENT" },
    );
  } finally {
    await panel.close();
    await f.close();
  }
});

test("panel embedding uses same-origin escaped assets and independent connection hooks", async () => {
  assert.throws(() => providerPanelHtml({ apiPath: "https://driver.example" }));
  assert.throws(() =>
    providerPanelHtml({ modulePath: "//untrusted.example/panel.js" }),
  );
  const markup = providerPanelHtml({ id: '\"><img src=x onerror=alert(1)>' });
  assert.ok(!markup.includes("<img"));
  assert.ok(!markup.includes("<script>"));
  let seen = "";
  const panel = providerPanel({
    client: () => undefined,
    connect: async (invite) => {
      seen = invite;
    },
    disconnect: async () => {
      seen = "";
    },
  });
  await panel({ action: "connect", invitation: "provided-by-application" });
  assert.equal(seen, "provided-by-application");
  await panel({ action: "disconnect" });
  assert.equal(seen, "");
  await assert.rejects(panel({ action: "snapshot", apiKey: "unexpected" }), {
    code: "INVALID_PANEL_REQUEST",
  });
  await assert.rejects(
    serveProviderPanel({ connectionPath: "/unused", host: "0.0.0.0" }),
    { code: "LOOPBACK_REQUIRED" },
  );
});
