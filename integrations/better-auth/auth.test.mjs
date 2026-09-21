import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { toNodeHandler } from "better-auth/node";
import {
  oauthProvider,
  oauthDeviceAuthorization,
  DEVICE_CODE_GRANT_TYPE,
} from "@better-auth/oauth-provider";
import { controlPlane } from "@authplane/better-auth";
import { AgenticDriver } from "../../dist/index.js";
import { AgenticClient } from "../../dist/client.js";
import { serve } from "../../dist/server.js";
import { betterAuthAuthentication } from "../../dist/better-auth.js";
import { BetterAuthPairingClient } from "../../dist/pairing.js";
import { mockProvider } from "../../dist/providers/mock.js";

const resource = "https://driver.example.test";
const projectKey = "ap_v1_" + "a".repeat(43);
const sha = (value) => createHash("sha256").update(value).digest("hex");
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function stop(server) {
  const done = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  await done;
}
async function fixture() {
  const archive = await readFile(
    new URL("vendor/authplane-better-auth-0.2.0.tgz", import.meta.url),
  );
  assert.equal(
    sha(archive),
    "4df6857225eb9a34502716ee58883392b090950a4d3651256ed5c8f371ac5bc6",
  );
  const directory = await mkdtemp(join(tmpdir(), "agenticdriver-better-auth-"));
  const database = new DatabaseSync(join(directory, "auth.sqlite"));
  database.exec("PRAGMA foreign_keys=ON");
  let outage = false,
    receivedEvents = 0;
  const management = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${projectKey}`);
    res.setHeader("Content-Type", "application/json");
    if (outage) {
      res.writeHead(503);
      res.end("{}");
      return;
    }
    if (req.url === "/internal/credentials/verify") {
      res.end(
        JSON.stringify({
          projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        }),
      );
    } else if (req.url === "/internal/events") {
      let text = "";
      for await (const part of req) text += part;
      const { events } = JSON.parse(text);
      receivedEvents += events.length;
      res.end(JSON.stringify({ acceptedIds: events.map((event) => event.id) }));
    } else {
      res.writeHead(404);
      res.end("{}");
    }
  });
  const managementUrl = await listen(management);
  let handle = (_req, res) => {
    res.writeHead(503);
    res.end();
  };
  let tokenRequests = 0;
  const application = createServer((req, res) => {
    if (req.url === "/api/auth/oauth2/token") tokenRequests++;
    return handle(req, res);
  });
  const origin = await listen(application);
  const connector = controlPlane({
    url: managementUrl,
    projectKey,
    allowInsecureHttp: true,
    events: { flushIntervalMs: 0 },
  });
  const auth = betterAuth({
    database,
    baseURL: origin,
    secret: randomBytes(48).toString("base64url"),
    trustedOrigins: [origin],
    emailAndPassword: { enabled: true },
    telemetry: { enabled: false },
    logger: { disabled: true },
    rateLimit: { enabled: false },
    plugins: [
      oauthProvider({
        disableJwtPlugin: true,
        loginPage: "/sign-in",
        consentPage: "/consent",
        scopes: ["ad:mock", "ad:other", "ad:lookup", "offline_access"],
        grantTypes: [
          "authorization_code",
          DEVICE_CODE_GRANT_TYPE,
          "refresh_token",
          "client_credentials",
        ],
        accessTokenExpiresIn: 300,
        m2mAccessTokenExpiresIn: 300,
        resources: [
          {
            identifier: resource,
            allowedScopes: [
              "ad:mock",
              "ad:other",
              "ad:lookup",
              "offline_access",
            ],
            accessTokenTtl: 300,
          },
        ],
        clientRegistrationDefaultResources: [resource],
        clientPrivileges: ({ user }) => Boolean(user),
      }),
      oauthDeviceAuthorization({
        verificationUri: origin + "/pair",
        interval: "1s",
      }),
      connector,
    ],
  });
  await (await getMigrations(auth.options)).runMigrations();
  await auth.$context;
  handle = toNodeHandler(auth);
  async function request(path, body, cookie, source = origin) {
    const form = path.startsWith("/oauth2/");
    const response = await fetch(origin + "/api/auth" + path, {
      method: body ? "POST" : "GET",
      redirect: "error",
      headers: {
        Origin: source,
        ...(body
          ? {
              "Content-Type": form
                ? "application/x-www-form-urlencoded"
                : "application/json",
            }
          : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body
        ? { body: form ? new URLSearchParams(body) : JSON.stringify(body) }
        : {}),
    });
    const text = await response.text();
    return { response, value: text ? JSON.parse(text) : null };
  }
  async function signup(email) {
    const { response, value } = await request("/sign-up/email", {
      name: email.split("@")[0],
      email,
      password: "synthetic-password-123456",
    });
    assert.equal(response.status, 200);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    return {
      userId: value.user.id,
      cookie,
      headers: new Headers({ Cookie: cookie, Origin: origin }),
    };
  }
  async function managementHealth() {
    const body = '{"input":{},"operation":"health"}';
    const path = "/api/auth/authplane/manage";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(24).toString("base64url");
    const signature = createHmac("sha256", projectKey)
      .update(
        [
          "authplane-management-v1",
          sha(projectKey),
          "POST",
          path,
          timestamp,
          nonce,
          sha(body),
        ].join("\n"),
      )
      .digest("hex");
    return fetch(origin + path, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        "x-authplane-protocol": "1",
        "x-authplane-key-id": sha(projectKey),
        "x-authplane-timestamp": timestamp,
        "x-authplane-nonce": nonce,
        "x-authplane-signature": signature,
      },
    });
  }
  return {
    auth,
    origin,
    connector,
    database,
    request,
    signup,
    managementHealth,
    get tokenRequests() {
      return tokenRequests;
    },
    get receivedEvents() {
      return receivedEvents;
    },
    set outage(value) {
      outage = value;
    },
    async close() {
      await connector.close();
      await stop(application);
      await stop(management);
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("real Better Auth device consent, SDK authorization and AuthYard management stay separate", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const alice = await f.signup("alice@example.test");
  const bob = await f.signup("bob@example.test");
  const issuer = f.origin + "/api/auth";
  const registerDevice = (name) =>
    f.auth.api.createOAuthClient({
      headers: alice.headers,
      body: {
        client_name: name,
        application_type: "native",
        token_endpoint_auth_method: "none",
        grant_types: [DEVICE_CODE_GRANT_TYPE, "refresh_token"],
        scope: "ad:mock ad:lookup offline_access",
      },
    });
  const device = await registerDevice("Alice workstation");
  const otherDevice = await registerDevice("Other workstation");
  const resourceClient = await f.auth.api.createOAuthClient({
    headers: alice.headers,
    body: {
      client_name: "Driver resource server",
      token_endpoint_auth_method: "client_secret_basic",
      grant_types: ["client_credentials"],
      scope: "ad:mock",
    },
  });
  const pairing = new BetterAuthPairingClient({
    issuer,
    resource,
    clientId: device.client_id,
    scopes: ["ad:mock", "ad:lookup", "offline_access"],
  });
  const pairingRequest = await pairing.start();
  let credentials;

  await t.test(
    "pending codes require review, same-user approval and the correct client",
    async () => {
      assert.equal(new URL(pairingRequest.verificationUri).origin, f.origin);
      const pending = await f.request("/oauth2/token", {
        grant_type: DEVICE_CODE_GRANT_TYPE,
        device_code: pairingRequest.deviceCode,
        client_id: device.client_id,
      });
      assert.equal(pending.value.error, "authorization_pending");
      const unclaimed = await f.request(
        "/device/approve",
        { userCode: pairingRequest.userCode },
        alice.cookie,
      );
      assert.equal(unclaimed.response.status, 400);
      const review = await f.request(
        "/device?user_code=" + encodeURIComponent(pairingRequest.userCode),
        undefined,
        alice.cookie,
      );
      assert.equal(review.value.client_id, device.client_id);
      assert.equal(review.value.resource, resource);
      assert.equal(review.value.scope, "ad:mock ad:lookup offline_access");
      const hostile = await f.request(
        "/device/approve",
        { userCode: pairingRequest.userCode },
        alice.cookie,
        "https://unrelated.example.test",
      );
      assert.equal(hostile.response.status, 403);
      const otherUser = await f.request(
        "/device/approve",
        { userCode: pairingRequest.userCode },
        bob.cookie,
      );
      assert.equal(otherUser.response.status, 403);
      const wrongClient = await f.request("/oauth2/token", {
        grant_type: DEVICE_CODE_GRANT_TYPE,
        device_code: pairingRequest.deviceCode,
        client_id: otherDevice.client_id,
      });
      assert.equal(wrongClient.value.error, "invalid_grant");
      assert.equal(
        (
          await f.request(
            "/device/approve",
            { userCode: pairingRequest.userCode },
            alice.cookie,
          )
        ).response.status,
        200,
      );
      credentials = await pairing.wait(pairingRequest);
      assert.ok(credentials.refreshToken);
      assert.ok(credentials.expiresAt > Date.now());
      const replay = await f.request("/oauth2/token", {
        grant_type: DEVICE_CODE_GRANT_TYPE,
        device_code: pairingRequest.deviceCode,
        client_id: device.client_id,
      });
      assert.equal(replay.response.status, 400);
    },
  );

  let enabled = true;
  let scopes = ["ad:mock", "ad:other", "ad:lookup"];
  let clientToken = credentials.accessToken;
  const usage = [];
  const other = mockProvider();
  other.info.id = "other";
  const runtime = new AgenticDriver({
    providers: [mockProvider(), other],
    usage: {
      hostId: "auth-fixture",
      accounts: { mock: "synthetic-account", other: "other-account" },
    },
    onUsage: (record) => {
      usage.push(record);
    },
  });
  const authorization = betterAuthAuthentication({
    issuer,
    resource,
    clientId: resourceClient.client_id,
    clientSecret: () => resourceClient.client_secret,
    scopes: {
      "ad:mock": { providers: ["mock"] },
      "ad:other": { providers: ["other"] },
      "ad:lookup": { providers: [], tools: ["lookup"] },
    },
    resolveGrant: async (identity) =>
      enabled &&
      identity.clientId === device.client_id &&
      identity.userId === alice.userId
        ? { id: "alice-workstation", subject: "alice-canonical", scopes }
        : undefined,
  });
  const host = await serve(runtime, {
    authentication: authorization,
    port: 0,
    allowedOrigins: [f.origin],
  });
  t.after(() => host.close());
  const client = new AgenticClient({ url: host.url, token: () => clientToken });
  const run = {
    provider: "mock",
    model: "demo",
    input: "Synthetic auth fixture",
  };

  await t.test(
    "scope intersections deny unconsented accounts; rotation keeps canonical usage identity",
    async () => {
      assert.deepEqual(
        (await client.providers()).map((provider) => provider.id),
        ["mock"],
      );
      await assert.rejects(client.run({ ...run, provider: "other" }), {
        code: "FORBIDDEN",
      });
      await client.run(run);
      const rotated = await pairing.refresh(credentials.refreshToken);
      assert.notEqual(rotated.refreshToken, credentials.refreshToken);
      clientToken = rotated.accessToken;
      await client.run(run);
      assert.ok(usage.length >= 2);
      assert.ok(
        usage.every(
          (record) =>
            record.subject === "alice-canonical" &&
            record.accountId === "synthetic-account",
        ),
      );
      scopes = ["ad:mock"];
      const current = await authorization.authenticate(
        clientToken,
        new AbortController().signal,
      );
      assert.deepEqual(current.tools, []);
      enabled = false;
      await assert.rejects(client.providers(), { code: "UNAUTHORIZED" });
      enabled = true;
      await client.providers();
      credentials = rotated;
    },
  );

  await t.test(
    "AuthYard verifies management, queues events on outage, and app auth remains operational",
    async () => {
      const healthy = await f.managementHealth();
      assert.equal(healthy.status, 200);
      const healthText = await healthy.text();
      assert.ok(healthText.includes("0.2.0") && healthText.includes("1.7.3"));
      assert.ok(
        !healthText.includes(projectKey) &&
          !healthText.includes(credentials.accessToken),
      );
      await f.connector.flushEvents();
      assert.ok(f.receivedEvents > 0);
      assert.equal((await f.connector.eventDeliveryState()).queued, 0);
      f.outage = true;
      const unavailable = await f.managementHealth();
      assert.equal(unavailable.status, 503);
      await unavailable.body.cancel();
      const signin = await f.request("/sign-in/email", {
        email: "alice@example.test",
        password: "synthetic-password-123456",
      });
      assert.equal(signin.response.status, 200);
      await f.connector.flushEvents();
      const state = await f.connector.eventDeliveryState();
      assert.ok(state.queued > 0);
      await client.run(run);
      f.outage = false;
    },
  );

  await t.test(
    "native revocation and refresh reuse invalidate credentials without host restart",
    async () => {
      await pairing.revoke(clientToken, "access_token");
      await assert.rejects(client.providers(), { code: "UNAUTHORIZED" });
      const next = await pairing.refresh(credentials.refreshToken);
      clientToken = next.accessToken;
      await client.providers();
      await assert.rejects(pairing.refresh(credentials.refreshToken), {
        code: "AUTH_REQUIRED",
      });
      await assert.rejects(client.providers(), { code: "UNAUTHORIZED" });
    },
  );

  await t.test(
    "explicit cancellation stops polling without native inference or further token calls",
    async () => {
      const waiting = await pairing.start();
      const controller = new AbortController();
      const before = f.tokenRequests;
      const wait = pairing.wait(waiting, controller.signal);
      controller.abort();
      await assert.rejects(wait, { name: "AbortError" });
      assert.equal(f.tokenRequests, before);
    },
  );

  await t.test(
    "service credentials have an explicit service identity and native expiry",
    async () => {
      const service = await f.auth.api.adminCreateOAuthClient({
        headers: alice.headers,
        body: {
          client_name: "Research worker",
          token_endpoint_auth_method: "client_secret_basic",
          grant_types: ["client_credentials"],
          scope: "ad:mock",
          client_credentials_scopes: ["ad:mock"],
        },
      });
      const minted = await fetch(issuer + "/oauth2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization:
            "Basic " +
            Buffer.from(
              service.client_id + ":" + service.client_secret,
            ).toString("base64"),
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          resource,
          scope: "ad:mock",
        }),
      });
      assert.equal(minted.status, 200);
      const issued = await minted.json();
      assert.equal(
        await authorization.authenticate(
          issued.access_token,
          new AbortController().signal,
        ),
        undefined,
      );
      const serviceAuth = betterAuthAuthentication({
        issuer,
        resource,
        clientId: resourceClient.client_id,
        clientSecret: () => resourceClient.client_secret,
        scopes: { "ad:mock": { providers: ["mock"] } },
        resolveGrant: async (identity) =>
          identity.clientId === service.client_id &&
          identity.userId === undefined
            ? {
                id: "research-worker",
                subject: "service:research",
                scopes: ["ad:mock"],
              }
            : undefined,
      });
      assert.equal(
        (
          await serviceAuth.authenticate(
            issued.access_token,
            new AbortController().signal,
          )
        ).subject,
        "service:research",
      );
      // Exercise the real native record's expiration check without a five-minute wall-clock sleep.
      const ctx = await f.auth.$context;
      await ctx.adapter.updateMany({
        model: "oauthAccessToken",
        where: [{ field: "clientId", value: service.client_id }],
        update: { expiresAt: new Date(Date.now() - 1000) },
      });
      assert.equal(
        await serviceAuth.authenticate(
          issued.access_token,
          new AbortController().signal,
        ),
        undefined,
      );
    },
  );
});
