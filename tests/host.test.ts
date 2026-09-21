import assert from "node:assert/strict";
import test from "node:test";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  configuredClient,
  configuredDriver,
  configuredServer,
  readHostConfig,
  secretResolver,
  validateHostConfig,
} from "../src/host.js";
import { AgenticDriver } from "../src/driver.js";
import { MemoryOperationStore } from "../src/operations.js";
import { mockProvider } from "../src/providers/mock.js";
import { serve } from "../src/server.js";
import { CliProcess } from "./cli-helpers.js";

const entry = [
  "--import",
  "tsx",
  fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
];
const token = "host-fixture-credential-at-least-32-characters";
function config() {
  return {
    version: 1,
    providers: [{ kind: "mock", id: "demo-host", models: ["demo"] }],
    tokens: [
      {
        id: "app",
        subject: "alice",
        providers: ["demo-host"],
        tokenRef: { env: "AD_HOST_TEST_TOKEN" },
      },
    ],
  };
}

test("host configuration rejects inline credentials, duplicate accounts, unsafe endpoints and unencrypted exposure", () => {
  const parsed = validateHostConfig(config());
  assert.deepEqual(parsed.listen, { host: "127.0.0.1", port: 7433 });
  assert.equal(parsed.limits?.idleTimeoutMs, undefined);
  for (const input of [
    { ...config(), apiKey: "must-not-be-echoed" },
    {
      ...config(),
      providers: [
        {
          kind: "openai",
          id: "p",
          models: ["demo"],
          apiKey: "must-not-be-echoed",
        },
      ],
    },
    { ...config(), providers: [...config().providers, ...config().providers] },
    { ...config(), tokens: [...config().tokens, ...config().tokens] },
    {
      ...config(),
      tokens: [{ ...config().tokens[0], providers: ["unknown"] }],
    },
    {
      ...config(),
      tokens: [
        {
          ...config().tokens[0],
          tokenRef: { env: "TOKEN", file: "also-a-file" },
        },
      ],
    },
  ])
    assert.throws(() => validateHostConfig(input), { code: "INVALID_CONFIG" });
  assert.throws(
    () => validateHostConfig({ ...config(), listen: { host: "0.0.0.0" } }),
    { code: "TLS_REQUIRED" },
  );
  assert.throws(
    () =>
      validateHostConfig({ ...config(), clientUrl: "http://remote.example" }),
    { code: "INSECURE_TRANSPORT" },
  );
  assert.throws(
    () =>
      validateHostConfig({
        ...config(),
        clientUrl: "https://user:must-not-be-echoed@example.com",
      }),
    { code: "INSECURE_TRANSPORT" },
  );
});

test("private file references are bounded, validated and distinct from configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agenticdriver-host-"));
  try {
    const path = join(directory, "secret");
    const secrets = secretResolver(directory);
    await writeFile(path, token + "\n", { mode: 0o600 });
    assert.equal(await secrets({ file: "secret" }), token);
    assert.equal(await secrets({ file: "missing" }), "");
    await assert.rejects(secrets({ file: "." }), {
      code: "SECRET_PERMISSIONS",
    });
    if (process.platform !== "win32") {
      await chmod(path, 0o644);
      await assert.rejects(secrets({ file: "secret" }), {
        code: "SECRET_PERMISSIONS",
      });
      await chmod(path, 0o600);
    }
    await writeFile(path, "x".repeat(65_537));
    await assert.rejects(secrets({ file: "secret" }), {
      code: "SECRET_TOO_LARGE",
    });
    await writeFile(path, Buffer.from([0xff]));
    await assert.rejects(secrets({ file: "secret" }), {
      code: "SECRET_UNAVAILABLE",
    });
    await writeFile(path, "must-not-be-echoed: invalid json");
    await assert.rejects(
      readHostConfig(path),
      (error: Error & { code?: string }) =>
        error.code === "INVALID_CONFIG" &&
        !error.message.includes("must-not-be-echoed"),
    );
    await writeFile(path, " ".repeat(1_000_001));
    await assert.rejects(readHostConfig(path), { code: "INVALID_CONFIG" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("supplied secret stores resolve scoped host and client credentials without embedding them", async () => {
  const cfg = validateHostConfig(config());
  let reads = 0;
  const secrets = async () => {
    reads++;
    return token;
  };
  const options = await configuredServer(cfg, "/unused/config.json", secrets);
  assert.equal(options.tokens[0]!.subject, "alice");
  assert.deepEqual(options.tokens[0]!.providers, ["demo-host"]);
  assert.equal(options.tokens[0]!.token, token);
  assert.equal(JSON.stringify(cfg).includes(token), false);
  const driver = configuredDriver(cfg, "/unused/config.json", { secrets });
  const server = await serve(driver, { ...options, port: 0 });
  try {
    const client = await configuredClient(cfg, "/unused/config.json", {
      secrets,
      url: server.url,
    });
    assert.equal(
      (await client.providers())[0]!.health!.code,
      "CATALOG_AVAILABLE",
    );
    assert.equal(
      (
        await client.run({
          provider: "demo-host",
          model: "demo",
          input: "hello",
        })
      ).text,
      "AgenticDriver is connected.",
    );
    assert.equal(reads, 2);
  } finally {
    await server.close();
  }
  await assert.rejects(
    configuredServer(cfg, "/unused/config.json", async () => "short"),
    { code: "AUTH_REQUIRED" },
  );
  await assert.rejects(
    configuredServer(
      validateHostConfig({
        ...cfg,
        tokens: [...cfg.tokens, { ...cfg.tokens[0], id: "another" }],
      }),
      "/unused/config.json",
      secrets,
    ),
    { code: "INVALID_CONFIG" },
  );
  await assert.rejects(
    configuredServer(
      validateHostConfig({
        ...cfg,
        tls: { certFile: "missing.pem", keyRef: { env: "TLS_KEY" } },
      }),
      "/unused/config.json",
      secrets,
    ),
    { code: "INVALID_TLS" },
  );
});

test("init creates private credentials without replacement and mock CLI commands work without SDK source edits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agenticdriver-cli-"));
  const path = join(directory, "config.json");
  const cli = (args: string[], input?: string) =>
    new CliProcess(entry, [...args, "--config", path, "--json"], { input });
  let server: CliProcess | undefined;
  try {
    const initialized = await cli(["init"]).finished;
    assert.equal(initialized.code, 0, initialized.stderr);
    const cfg = await readHostConfig(path);
    assert.equal(cfg.providers[0]!.kind, "mock");
    const credentials = await readdir(join(directory, "credentials"));
    assert.equal(credentials.length, 1);
    const secret = (
      await readFile(join(directory, "credentials", credentials[0]!), "utf8")
    ).trim();
    assert.ok(secret.length >= 32);
    assert.equal(initialized.stdout.includes(secret), false);
    assert.equal((await readFile(path, "utf8")).includes(secret), false);
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal(
        (await stat(join(directory, "credentials", credentials[0]!))).mode &
          0o777,
        0o600,
      );
    }
    const old = await readFile(path, "utf8");
    const replacement = await cli(["init", "--provider-id", "replacement"])
      .finished;
    assert.equal(replacement.code, 1);
    assert.equal(JSON.parse(replacement.stderr).error.code, "CONFIG_EXISTS");
    assert.equal(await readFile(path, "utf8"), old);
    assert.deepEqual(
      await readdir(join(directory, "credentials")),
      credentials,
    );
    assert.equal((await cli(["doctor"]).finished).code, 0);
    const insecure = await cli(["serve", "--host", "0.0.0.0"]).finished;
    assert.equal(JSON.parse(insecure.stderr).error.code, "TLS_REQUIRED");
    server = cli(["serve", "--port", "0"]);
    const url = await server.listening();
    const status = await cli(["status", "--url", url]).finished;
    assert.equal(status.code, 0, status.stderr);
    assert.equal(status.stdout.includes(secret), false);
    const first = await cli(
      [
        "run",
        "--url",
        url,
        "--provider",
        "mock",
        "--model",
        "demo",
        "--idempotency-key",
        "mock-run",
      ],
      "hello 🌍",
    ).finished;
    assert.equal(first.code, 0, first.stderr);
    const completed = first.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .at(-1);
    assert.equal(completed.type, "run.completed");
    const replay = await cli(
      [
        "run",
        "--url",
        url,
        "--provider",
        "mock",
        "--model",
        "demo",
        "--idempotency-key",
        "mock-run",
      ],
      "hello 🌍",
    ).finished;
    assert.equal(replay.code, 0, replay.stderr);
    assert.deepEqual(
      JSON.parse(replay.stdout.trim().split("\n").at(-1)!).result,
      completed.result,
    );
    const stopped = await server.stop();
    // Windows termination is forceful; it does not exercise POSIX graceful shutdown.
    if (process.platform === "win32") assert.equal(stopped.signal, "SIGTERM");
    else assert.equal(stopped.code, 0);
  } finally {
    await server?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI diagnostics discover only the selected API account and redact rejected provider bodies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agenticdriver-doctor-"));
  const path = join(directory, "config.json");
  const apiSecret = "never-print-this-fixture-api-key";
  let calls = 0;
  const api = createServer((req, res) => {
    calls++;
    assert.equal(req.url, "/v1/models");
    assert.equal(req.method, "GET");
    assert.equal(req.headers.authorization, `Bearer ${apiSecret}`);
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: apiSecret }));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  assert.ok(address && typeof address !== "string");
  try {
    const init = await new CliProcess(entry, [
      "init",
      "--config",
      path,
      "--provider",
      "openai",
      "--provider-id",
      "work",
      "--model",
      "explicit-model",
      "--api-key-env",
      "AD_HOST_FIXTURE_KEY",
      "--base-url",
      `http://127.0.0.1:${address.port}/v1`,
      "--json",
    ]).finished;
    assert.equal(init.code, 0, init.stderr);
    const environment = { ...process.env, AD_HOST_FIXTURE_KEY: apiSecret };
    const doctor = await new CliProcess(
      entry,
      ["doctor", "--config", path, "--json"],
      { env: environment },
    ).finished;
    assert.equal(doctor.code, 1);
    const report = JSON.parse(doctor.stdout);
    assert.equal(report.providers[0].id, "work");
    assert.equal(report.providers[0].health.code, "AUTH_REJECTED");
    assert.equal((doctor.stdout + doctor.stderr).includes(apiSecret), false);
    assert.equal(calls, 1);
    delete (environment as NodeJS.ProcessEnv).AD_HOST_FIXTURE_KEY;
    const missing = await new CliProcess(
      entry,
      ["doctor", "--config", path, "--json"],
      { env: environment },
    ).finished;
    assert.equal(
      JSON.parse(missing.stdout).providers[0].health.code,
      "AUTH_REQUIRED",
    );
    assert.equal(
      calls,
      1,
      "Missing credentials cannot trigger a request or fallback account",
    );
  } finally {
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("host shutdown waits for cancellation records and is safe to call twice", async () => {
  const memory = new MemoryOperationStore();
  let begun!: () => void;
  const started = new Promise<void>((resolve) => {
    begun = resolve;
  });
  let terminalSaved = false;
  const driver = new AgenticDriver({
    providers: [
      mockProvider(async () => {
        begun();
        return new Promise(() => {});
      }),
    ],
    operations: {
      async claim(...args) {
        const claimed = await memory.claim(...args);
        if (!claimed.created) return claimed;
        return {
          ...claimed,
          writer: {
            ...claimed.writer,
            async append(event) {
              if (event.type === "run.cancelled") {
                await new Promise((resolve) => setTimeout(resolve, 30));
                terminalSaved = true;
              }
              await claimed.writer.append(event);
            },
          },
        };
      },
    },
  });
  const server = await serve(driver, {
    port: 0,
    tokens: [{ token, subject: "alice", providers: ["mock"] }],
  });
  const request = {
    provider: "mock",
    model: "demo",
    input: "wait",
    idempotencyKey: "shutdown",
  };
  const response = await fetch(server.url + "/v1/runs", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(request),
  });
  const disconnected = response.text().catch(() => "");
  await started;
  await Promise.all([server.close(), server.close()]);
  await disconnected;
  assert.equal(terminalSaved, true);
  await assert.rejects(driver.run(request, { subject: "alice" }), {
    code: "CANCELLED",
  });
});
