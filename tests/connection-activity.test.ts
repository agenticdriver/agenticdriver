import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { hostConnections, withConnections } from "../src/connections.js";
import { AgenticDriver } from "../src/driver.js";
import { AgenticClient } from "../src/client.js";
import { mockProvider } from "../src/providers/mock.js";
import { serve } from "../src/server.js";

test("connection activity observes authenticated requests and cleans up errors, cancelled streams and shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "driver-activity-"));
  const path = join(directory, "connections.json");
  const store = await hostConnections(path, { providers: () => ["mock"] });
  const admin = "activity-operator-credential-at-least-32-characters";
  const server = await serve(
    new AgenticDriver({
      providers: [
        mockProvider((request) =>
          request.messages.some((m) => m.content === "wait")
            ? new Promise(() => {})
            : { text: "synthetic" },
        ),
      ],
    }),
    withConnections(
      {
        port: 0,
        tokens: [
          {
            token: admin,
            subject: "operator",
            providers: [],
            manageProviders: true,
          },
        ],
      },
      store,
    ),
  );
  const operator = new AgenticClient({ url: server.url, token: admin });
  const cancel = new AbortController();
  try {
    const invite = await operator.createInvitation({
      grant: { subject: "app", providers: ["mock"] },
    });
    const credentials = await store.exchange(invite.code);
    const client = new AgenticClient({
      url: server.url,
      token: credentials.token,
    });
    const info = async () => (await store.list()).connections[0]!;
    assert.equal((await info()).lastSeenAt, undefined);
    const unauthorized = new AgenticClient({
      url: server.url,
      token: "not-an-authorized-credential",
    });
    await assert.rejects(unauthorized.providers(), { code: "UNAUTHORIZED" });
    assert.equal((await info()).lastSeenAt, undefined);
    await client.run({ provider: "mock", model: "demo", input: "finish" });
    assert.equal((await info()).activeRequests, 0);
    assert.ok((await info()).lastSeenAt);
    await assert.rejects(client.connections(), { code: "FORBIDDEN" });
    assert.equal((await info()).activeRequests, 0);
    const stream = () =>
      fetch(server.url + "/v1/runs", {
        method: "POST",
        signal: cancel.signal,
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          provider: "mock",
          model: "demo",
          input: "wait",
        }),
      });
    const pending = await stream();
    assert.equal(pending.status, 200);
    assert.equal(
      (await operator.connections()).connections[0]!.activeRequests,
      1,
    );
    await assert.rejects(
      client.run({ provider: "mock", model: "unknown", input: "failure" }),
      { code: "UNSUPPORTED_MODEL" },
    );
    assert.equal((await info()).activeRequests, 1);
    cancel.abort();
    await pending.body?.cancel().catch(() => {});
    for (
      let attempt = 0;
      attempt < 100 && (await info()).activeRequests !== 0;
      attempt++
    )
      await delay(10);
    assert.equal((await info()).activeRequests, 0);
    const next = await fetch(server.url + "/v1/runs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ provider: "mock", model: "demo", input: "wait" }),
    });
    assert.equal(next.status, 200);
    assert.equal((await info()).activeRequests, 1);
    await server.close();
    await next.body?.cancel().catch(() => {});
    assert.equal((await info()).activeRequests, 0);
    assert.equal((await readFile(path, "utf8")).includes("lastSeenAt"), false);
    const restarted = await hostConnections(path, {
      providers: () => ["mock"],
    });
    assert.equal(
      (await restarted.list()).connections[0]!.lastSeenAt,
      undefined,
    );
    assert.equal(
      (await restarted.list()).connections[0]!.activeRequests,
      undefined,
    );
    await store.revoke({ id: credentials.id });
    assert.deepEqual((await store.list()).connections, []);
    assert.equal(await store.authenticate(credentials.token), undefined);
  } finally {
    cancel.abort();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
