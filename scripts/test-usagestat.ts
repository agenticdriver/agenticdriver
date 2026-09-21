/** Exercise the SDK against the actual native Usagestat dependency, without provider credentials. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AgenticDriver } from "../src/driver.js";
import { configuredDriver, validateHostConfig } from "../src/host.js";
import { MemoryOperationStore } from "../src/operations.js";
import { mockProvider } from "../src/providers/mock.js";
import { UsageStatClient } from "../src/usagestat.js";
import type { UsageRecord } from "../src/types.js";

const binary = process.argv[2] ?? process.env.USAGESTATD;
if (!binary)
  throw new Error(
    "Pass the Usagestat binary: npm run test:usagestat -- /absolute/path/to/usagestatd (build usagestat-daemon in the backend repository first).",
  );
const directory = await mkdtemp(join(tmpdir(), "agenticdriver-usagestat-"));
const token = "native-sdk-metering-fixture-token-at-least-32-characters";
const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = (reservation.address() as { port: number }).port;
await new Promise<void>((resolve, reject) =>
  reservation.close((error) => (error ? reject(error) : resolve())),
);
const url = `http://127.0.0.1:${port}`;
let daemon: ChildProcess | undefined;
async function start() {
  daemon = spawn(
    resolve(binary!),
    [
      "--no-poll",
      "--bind",
      `127.0.0.1:${port}`,
      "--run-usage-config",
      join(directory, "ingestion.json"),
    ],
    {
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        USAGESTAT_CONFIG_DIR: join(directory, "config"),
        USAGESTAT_DATA_DIR: join(directory, "data"),
      },
      stdio: "ignore",
    },
  );
  let failure: Error | undefined;
  daemon.on("error", (error) => {
    failure = error;
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (failure || daemon.exitCode !== null)
      throw new Error("The native Usagestat fixture did not start.");
    try {
      if (
        (await fetch(`${url}/health`, { signal: AbortSignal.timeout(200) })).ok
      )
        return;
    } catch {}
    await delay(50);
  }
  throw new Error("The native Usagestat fixture did not become ready.");
}
async function stop() {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    const stopped = once(daemon, "exit");
    daemon.kill();
    await stopped;
  }
  daemon = undefined;
}
try {
  await writeFile(join(directory, "backend.key"), token, { mode: 0o600 });
  await writeFile(
    join(directory, "ingestion.json"),
    JSON.stringify({
      version: 1,
      database: "private/runs.sqlite",
      clients: [
        {
          token: { file: "backend.key" },
          bindings: [
            {
              hostId: "sdk-host",
              provider: "mock",
              accountId: "sdk-account",
              subjects: ["sdk-app"],
            },
          ],
        },
      ],
    }),
    { mode: 0o600 },
  );
  await start();
  const backend = new UsageStatClient({ url, token });
  assert.ok(
    (await backend.ingestionProtocol()).eventSchemas.includes(
      "agenticdriver.usage.v2",
    ),
  );
  const captured: UsageRecord[] = [],
    errors: unknown[] = [];
  let generations = 0;
  const driver = new AgenticDriver({
    providers: [
      mockProvider(() => {
        generations++;
        return { text: "answer", usage: { inputTokens: 9, outputTokens: 3 } };
      }),
    ],
    usage: { hostId: "sdk-host", accounts: { mock: "sdk-account" } },
    operations: new MemoryOperationStore(),
    onUsage: async (record) => {
      captured.push(record);
      await backend.capture(record);
    },
    onTelemetryError: (error) => errors.push(error),
  });
  const request = {
    provider: "mock",
    model: "demo",
    input: "private grounding context",
    idempotencyKey: "native-integration",
  };
  const result = await driver.run(request, { subject: "sdk-app" });
  assert.equal(errors.length, 0);
  assert.equal(captured.length, 1);
  const identity = {
    hostId: "sdk-host",
    provider: "mock",
    accountId: "sdk-account",
    subject: "sdk-app",
  };
  const stored = await backend.run(identity, captured[0]!.eventId);
  assert.deepEqual(stored.record.usage, result.usage);
  assert.equal(stored.delivery, "local");
  assert.equal(JSON.stringify(stored).includes(request.input), false);
  assert.equal((await backend.capture(captured[0]!)).status, "duplicate");
  await driver.run(request, { subject: "sdk-app" });
  assert.equal(generations, 1);
  assert.equal(captured.length, 1);
  // The host's real secret resolver and config path use the same backend contract.
  const host = configuredDriver(
    validateHostConfig({
      version: 1,
      usage: { hostId: "sdk-host" },
      providers: [
        {
          kind: "mock",
          id: "mock",
          models: ["demo"],
          accountId: "sdk-account",
        },
      ],
      tokens: [
        {
          id: "app",
          subject: "sdk-app",
          providers: ["mock"],
          tokenRef: { file: "backend.key" },
        },
      ],
      usagestat: { url, tokenRef: { file: "backend.key" } },
    }),
    join(directory, "host.json"),
    { onTelemetryError: (error) => errors.push(error) },
  );
  const hosted = await host.run(
    { provider: "mock", model: "demo", input: "fixture" },
    { subject: "sdk-app" },
  );
  assert.equal(
    (await backend.run(identity, hosted.runId)).record.runId,
    hosted.runId,
  );
  assert.equal(errors.length, 0);
  // An unavailable first hop cannot promise capture, but cannot trigger inference retries either.
  await stop();
  await driver.run(
    { ...request, idempotencyKey: "offline-first-hop" },
    { subject: "sdk-app" },
  );
  assert.equal(generations, 2);
  assert.equal(errors.length, 1);
  assert.equal(captured.length, 2);
  await start();
  assert.equal(
    (await backend.run(identity, captured[0]!.eventId)).record.runId,
    captured[0]!.runId,
  );
  await backend.capture(captured[1]!);
  assert.equal(generations, 2);
  assert.equal(
    (await backend.run(identity, captured[1]!.eventId)).delivery,
    "local",
  );
  console.log(
    "Native Usagestat SDK integration passed: explicit accounts, version compatibility, secret references, capture, reconciliation, restart and no generation retry.",
  );
} finally {
  await stop();
  await rm(directory, { recursive: true, force: true });
}
