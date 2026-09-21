import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { betterAuthAuthentication } from "../src/better-auth.js";
import { BetterAuthPairingClient } from "../src/pairing.js";
import { AgenticDriver } from "../src/driver.js";
import { AgenticClient } from "../src/client.js";
import { serve, type HostAuthentication } from "../src/server.js";
import { mockProvider } from "../src/providers/mock.js";

const issuer = "https://app.example.test/api/auth";
const resource = "https://driver.example.test";
const token = "opaque-fixture-access-token-32-characters";
const signal = () => new AbortController().signal;
const claims = () => ({
  active: true,
  iss: issuer,
  aud: resource,
  client_id: "device-one",
  sub: "alice",
  exp: Math.floor(Date.now() / 1000) + 300,
  scope: "driver:run",
  token_type: "Bearer",
});
function authority(
  fetcher: typeof fetch,
  resolveGrant = async () => ({
    id: "device-grant",
    subject: "alice",
    scopes: ["driver:run"],
  }),
) {
  return betterAuthAuthentication({
    issuer,
    resource,
    clientId: "host",
    clientSecret: () => "fixture-resource-secret",
    scopes: { "driver:run": { providers: ["mock"] } },
    fetch: fetcher,
    resolveGrant,
  });
}

test("introspection authenticates only an active exact issuer/resource bearer and never forwards cookies", async () => {
  let body: Record<string, unknown> = claims();
  let grants = 0,
    requests = 0;
  const auth = authority(
    async (input, init) => {
      requests++;
      assert.equal(String(input), issuer + "/oauth2/introspect");
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.redirect, "error");
      assert.equal(new URLSearchParams(String(init?.body)).get("token"), token);
      assert.equal(new Headers(init?.headers).has("Cookie"), false);
      return Response.json(body);
    },
    async () => {
      grants++;
      return { id: "grant", subject: "alice", scopes: ["driver:run"] };
    },
  );
  assert.equal((await auth.authenticate(token, signal()))?.subject, "alice");
  for (const override of [
    { active: false },
    { iss: "https://unrelated.example.test/api/auth" },
    { aud: "https://other-driver.example.test" },
    { exp: Math.floor(Date.now() / 1000) - 1 },
    { cnf: { jkt: "requires-proof" } },
    { token_type: "DPoP" },
    { client_id: "" },
  ]) {
    body = { ...claims(), ...override };
    assert.equal(await auth.authenticate(token, signal()), undefined);
  }
  assert.equal(grants, 1);
  const before = requests;
  assert.equal(
    await auth.authenticate("header.payload.signature", signal()),
    undefined,
  );
  assert.equal(requests, before);
});

test("auth outages, malformed bodies and cancellation fail closed without returning secret details", async () => {
  const secret = "private-provider-or-auth-response";
  for (const fetcher of [
    async () => new Response(secret, { status: 503 }),
    async () => new Response(secret),
    async () => Response.json({ secret: secret.repeat(40_000) }),
    async () => {
      throw new Error(secret);
    },
  ]) {
    await assert.rejects(
      authority(fetcher).authenticate(token, signal()),
      (error: Error & { code?: string }) =>
        error.code === "AUTH_UNAVAILABLE" && !error.message.includes(secret),
    );
  }
  const controller = new AbortController();
  const waiting = authority(
    async () => new Promise<Response>(() => {}),
  ).authenticate(token, controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
});

test("application authorization changes are rechecked before queued foreground work starts", async () => {
  let calls = 0,
    changed = false,
    requestChecks = 0;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = new AgenticDriver({
    providers: [
      mockProvider(async () => {
        calls++;
        await waiting;
        return { text: "completed" };
      }),
    ],
  });
  const authentication: HostAuthentication = {
    authenticate: async () => {
      requestChecks++;
      return {
        id: "grant",
        subject: "alice",
        providers: changed ? [] : ["mock"],
      };
    },
  };
  const host = await serve(runtime, {
    authentication,
    scheduling: { total: 1, queue: { total: 4, perSubject: 4 } },
    port: 0,
  });
  try {
    const client = new AgenticClient({ url: host.url, token });
    const run = { provider: "mock", model: "demo", input: "fixture" };
    const first = client.run(run);
    while (!calls) await delay(5);
    const queued = client.run(run);
    const rejected = assert.rejects(queued, { code: "FORBIDDEN" });
    while (requestChecks < 3) await delay(5);
    changed = true;
    release();
    await first;
    await rejected;
    assert.equal(calls, 1);
  } finally {
    release();
    await host.close();
  }
});

test("host shutdown cancels authentication even when an application callback ignores its signal", async () => {
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const host = await serve(new AgenticDriver({ providers: [mockProvider()] }), {
    port: 0,
    authentication: {
      authenticate: async () => {
        started();
        return new Promise(() => {});
      },
    },
  });
  const client = new AgenticClient({ url: host.url, token });
  const result = client.providers().catch(() => undefined);
  await pending;
  await host.close();
  await result;
});

test("pairing rejects foreign verification URLs, scope escalation and overlapping refreshes", async () => {
  const client = new BetterAuthPairingClient({
    issuer,
    resource,
    clientId: "device",
    scopes: ["driver:run"],
    fetch: async () =>
      Response.json({
        device_code: token,
        user_code: "ABCD-1234",
        verification_uri: "https://unrelated.example.test/pair",
        expires_in: 300,
      }),
  });
  await assert.rejects(client.start(), { code: "INVALID_AUTH_RESPONSE" });
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const refresh = new BetterAuthPairingClient({
    issuer,
    resource,
    clientId: "device",
    scopes: ["driver:run"],
    fetch: async () => {
      await waiting;
      return Response.json({
        access_token: token,
        refresh_token: "next-refresh",
        token_type: "Bearer",
        expires_in: 300,
        scope: "driver:admin",
      });
    },
  });
  const one = refresh.refresh("refresh-one");
  const invalid = assert.rejects(one, { code: "INVALID_AUTH_RESPONSE" });
  await assert.rejects(refresh.refresh("refresh-two"), {
    code: "AUTH_REFRESH_IN_PROGRESS",
  });
  release();
  await invalid;
});

test("client credential resolvers cancel cleanly and redact their failure details", async () => {
  let requests = 0;
  const fetcher: typeof fetch = async () => {
    requests++;
    return Response.json({});
  };
  const failed = new AgenticClient({
    url: resource,
    fetch: fetcher,
    token: async () => {
      throw new Error("private-secret-store-payload");
    },
  });
  await assert.rejects(
    failed.providers(),
    (error: Error & { code?: string }) =>
      error.code === "AUTH_UNAVAILABLE" &&
      !error.message.includes("private-secret-store-payload"),
  );
  const controller = new AbortController();
  const waiting = new AgenticClient({
    url: resource,
    fetch: fetcher,
    token: async () => new Promise<string>(() => {}),
  }).providers({ signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal(requests, 0);
});

test("pairing follows RFC pending/slow-down intervals and never retries an uncertain rotation", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const times: number[] = [];
  const replies = [
    { error: "authorization_pending" },
    { error: "slow_down" },
    {
      access_token: token,
      token_type: "Bearer",
      expires_in: 300,
      scope: "driver:run",
    },
  ];
  const client = new BetterAuthPairingClient({
    issuer,
    resource,
    clientId: "device",
    scopes: ["driver:run"],
    fetch: async () => {
      times.push(Date.now());
      const value = replies.shift()!;
      return Response.json(value, { status: "error" in value ? 400 : 200 });
    },
  });
  const initial = Date.now();
  const pending = client.wait({
    deviceCode: token,
    userCode: "ABCD",
    verificationUri: issuer + "/pair",
    expiresAt: initial + 100_000,
    intervalMs: 1000,
  });
  const settle = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  t.mock.timers.tick(1000);
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  t.mock.timers.tick(5999);
  await settle();
  assert.equal(times.length, 2);
  t.mock.timers.tick(1);
  await settle();
  assert.equal((await pending).accessToken, token);
  assert.deepEqual(
    times.map((time) => time - initial),
    [1000, 2000, 8000],
  );
  let attempts = 0;
  const uncertain = new BetterAuthPairingClient({
    issuer,
    resource,
    clientId: "device",
    scopes: ["driver:run"],
    fetch: async () => {
      attempts++;
      throw new Error("private server exception");
    },
  });
  await assert.rejects(uncertain.refresh("refresh"), {
    code: "AUTH_UNAVAILABLE",
  });
  assert.equal(attempts, 1);
});
