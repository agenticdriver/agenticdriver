import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AgenticDriver } from "../src/driver.js";
import { AgenticClient } from "../src/client.js";
import { DriverError } from "../src/errors.js";
import { serve } from "../src/server.js";
import {
  anthropic,
  claudeCode,
  codex,
  gemini,
  geminiCli,
  openai,
  openaiCompatible,
  xai,
  xaiResponses,
} from "../src/providers/index.js";
import { mockProvider } from "../src/providers/mock.js";
import type { ProviderAdapter } from "../src/types.js";

const token = "discovery-test-token-at-least-32-characters";
const reply = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

test("remote discovery filters accounts before probing, refreshes credentials and preserves explicit allowlists", async () => {
  let key = "expired-test-secret",
    queries = 0,
    hiddenQueries = 0,
    generations = 0;
  const first = openai({
    id: "openai-personal",
    models: ["alias", "available"],
    apiKey: () => key,
    fetch: (async (_url, init) => {
      assert.equal(init?.method, "GET");
      assert.equal(init?.body, undefined);
      queries++;
      assert.equal(
        new Headers(init.headers).get("Authorization"),
        `Bearer ${key}`,
      );
      return key.startsWith("expired")
        ? reply({ secret: key }, 401)
        : reply({ data: [{ id: "available" }, { id: "private-model" }] });
    }) as typeof fetch,
  });
  first.complete = async () => {
    generations++;
    throw new DriverError("PROVIDER_AUTH", "Credential rejected.");
  };
  const other = openai({
    id: "openai-work",
    apiKey: "hidden-secret",
    fetch: (async () => {
      hiddenQueries++;
      return reply({ data: [] });
    }) as typeof fetch,
  });
  other.complete = async () => {
    throw new Error("Must never switch accounts");
  };
  const driver = new AgenticDriver({
    providers: [first, other],
    discovery: { minRefreshMs: 0 },
  });
  const server = await serve(driver, {
    port: 0,
    tokens: [{ token, subject: "alice", providers: [first.info.id] }],
  });
  try {
    const client = new AgenticClient({ url: server.url, token });
    const unavailable = await client.providers();
    assert.equal(unavailable.length, 1);
    assert.equal(unavailable[0]!.health?.code, "AUTH_REJECTED");
    assert.equal(unavailable[0]!.health?.status, "unauthenticated");
    assert.equal(JSON.stringify(unavailable).includes("secret"), false);
    key = "renewed-test-secret";
    assert.equal((await client.providers())[0]!.health?.code, "AUTH_REJECTED");
    const refreshed = (await client.providers({ refresh: true }))[0]!;
    assert.equal(refreshed.health?.status, "ready");
    assert.deepEqual(refreshed.models, ["alias", "available"]);
    assert.deepEqual(refreshed.modelCatalog, {
      source: "provider",
      models: ["available"],
      complete: true,
    });
    assert.equal(queries, 2);
    assert.equal(hiddenQueries, 0);
    assert.equal(generations, 0);
    await assert.rejects(
      client.run({
        provider: first.info.id,
        model: "private-model",
        input: "Hello",
      }),
      { code: "UNSUPPORTED_MODEL" },
    );
    await assert.rejects(
      client.run({ provider: first.info.id, model: "alias", input: "Hello" }),
      { code: "PROVIDER_AUTH" },
    );
    assert.equal(generations, 1);
    assert.equal(hiddenQueries, 0);
    assert.deepEqual(
      (await driver.discoverProviders()).map((p) => p.id),
      [first.info.id, other.info.id],
    );
    assert.equal(hiddenQueries, 1);
  } finally {
    await server.close();
  }
});

test("overlapping checks coalesce; one cancelled reader cannot cancel another reader", async () => {
  let probes = 0;
  const adapter: ProviderAdapter = {
    ...mockProvider(),
    inspect: async ({ signal }) => {
      probes++;
      await delay(40, undefined, { signal });
      return { code: "CATALOG_AVAILABLE", models: ["demo"], complete: true };
    },
  };
  const driver = new AgenticDriver({
    providers: [adapter],
    discovery: { minRefreshMs: 0 },
  });
  const controller = new AbortController();
  const first = driver.discoverProviders({ signal: controller.signal });
  const second = driver.discoverProviders({ refresh: true });
  controller.abort();
  await assert.rejects(first);
  assert.equal((await second)[0]!.health?.status, "ready");
  assert.equal(probes, 1);
  const result = await driver.discoverProviders();
  result[0]!.modelCatalog!.models.push("mutation");
  assert.deepEqual(
    (await driver.discoverProviders())[0]!.modelCatalog!.models,
    ["demo"],
  );
});

test("cached checks expire and explicit refresh respects the configured minimum interval", async () => {
  let probes = 0;
  const driver = new AgenticDriver({
    providers: [
      {
        ...mockProvider(),
        inspect: async () => {
          probes++;
          return { code: "CATALOG_AVAILABLE", models: [`model-${probes}`] };
        },
      },
    ],
    discovery: { cacheTtlMs: 25, minRefreshMs: 25 },
  });
  await driver.discoverProviders();
  await driver.discoverProviders({ refresh: true });
  assert.equal(probes, 1);
  await delay(40);
  await driver.discoverProviders();
  assert.equal(probes, 2);
});

test("stalled and malformed probes are bounded and redact all adapter diagnostics", async () => {
  let aborted = false;
  const adapters: ProviderAdapter[] = [
    {
      ...mockProvider(),
      info: { ...mockProvider().info, id: "stalled" },
      inspect: ({ signal }) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise(() => {});
      },
    },
    {
      ...mockProvider(),
      info: { ...mockProvider().info, id: "failed" },
      inspect: async () => {
        throw new DriverError("secret-key", "private-account@example.com");
      },
    },
    {
      ...mockProvider(),
      info: { ...mockProvider().info, id: "invalid" },
      inspect: async () => ({ code: "CATALOG_AVAILABLE" }),
    },
  ];
  const driver = new AgenticDriver({
    providers: adapters,
    discovery: { timeoutMs: 25 },
  });
  const result = await driver.discoverProviders();
  assert.deepEqual(
    result.map((p) => p.health!.code),
    ["DISCOVERY_TIMEOUT", "DISCOVERY_FAILED", "INVALID_DISCOVERY_RESPONSE"],
  );
  assert.equal(aborted, true);
  assert.doesNotMatch(JSON.stringify(result), /secret-key|private-account/);
  // Discovery's housekeeping timer is unrelated to the runtime's optional inactivity policy.
  assert.equal(
    (await driver.run({ provider: "stalled", model: "demo", input: "Hello" }))
      .finishReason,
    "stop",
  );
});

test("API probes use documented GET routes, host keys and bounded pagination", async () => {
  for (const vendor of [
    "openai",
    "anthropic",
    "gemini",
    "xai",
    "xaiResponses",
    "compatible",
  ] as const) {
    const calls: URL[] = [];
    const fetcher = (async (input, init) => {
      const url = new URL(String(input));
      calls.push(url);
      assert.equal(url.origin, "https://catalog.example.com");
      assert.equal(url.pathname, "/v1/models");
      assert.equal(init?.method, "GET");
      assert.equal(init?.body, undefined);
      assert.equal(init?.redirect, "error");
      const headers = new Headers(init?.headers);
      assert.equal(
        headers.get(
          vendor === "anthropic"
            ? "x-api-key"
            : vendor === "gemini"
              ? "x-goog-api-key"
              : "Authorization",
        ),
        ["anthropic", "gemini"].includes(vendor)
          ? "test-key"
          : "Bearer test-key",
      );
      if (vendor === "anthropic") {
        assert.equal(headers.get("anthropic-version"), "2023-06-01");
        if (calls.length === 1)
          return reply({ data: [{ id: "a" }], has_more: true, last_id: "a" });
        assert.equal(url.searchParams.get("after_id"), "a");
        return reply({ data: [{ id: "b" }], has_more: false, last_id: "b" });
      }
      if (vendor === "gemini") {
        if (calls.length === 1)
          return reply({
            models: [
              {
                name: "models/a",
                supportedGenerationMethods: ["generateContent"],
              },
              {
                name: "models/embed",
                supportedGenerationMethods: ["embedContent"],
              },
            ],
            nextPageToken: "next/=&",
          });
        assert.equal(url.searchParams.get("pageToken"), "next/=&");
        return reply({
          models: [
            {
              name: "models/b",
              supportedGenerationMethods: ["generateContent"],
            },
          ],
        });
      }
      return reply({ data: [{ id: "a" }, { id: "b" }] });
    }) as typeof fetch;
    const options = {
      apiKey: "test-key",
      baseUrl: "https://catalog.example.com/v1/",
      fetch: fetcher,
    };
    const adapter = {
      openai,
      anthropic,
      gemini,
      xai,
      xaiResponses,
      compatible: openaiCompatible,
    }[vendor](options);
    const [info] = await new AgenticDriver({
      providers: [adapter],
    }).discoverProviders();
    assert.deepEqual(info!.modelCatalog, {
      source: "provider",
      models: ["a", "b"],
      complete: true,
    });
    assert.equal(
      calls.length,
      ["anthropic", "gemini"].includes(vendor) ? 2 : 1,
    );
  }
});

test("API probe failures preserve authentication and capability distinctions without exposing bodies", async () => {
  for (const [status, code] of [
    [401, "AUTH_REJECTED"],
    [403, "ACCESS_DENIED"],
    [429, "RATE_LIMITED"],
    [404, "DISCOVERY_UNSUPPORTED"],
    [503, "DISCOVERY_FAILED"],
  ] as const) {
    const driver = new AgenticDriver({
      providers: [
        openai({
          apiKey: "test",
          fetch: (async () =>
            reply({ apiKey: "never-public" }, status)) as typeof fetch,
        }),
      ],
    });
    const [info] = await driver.discoverProviders();
    assert.equal(info!.health!.code, code);
    assert.doesNotMatch(JSON.stringify(info), /never-public/);
  }
  const missing = openai({
    apiKey: "",
    fetch: (async () => {
      assert.fail("Missing keys must not make network requests");
    }) as typeof fetch,
  });
  assert.equal(
    (await new AgenticDriver({ providers: [missing] }).discoverProviders())[0]!
      .health!.code,
    "AUTH_REQUIRED",
  );
  const broken = openai({
    apiKey: "test",
    fetch: (async () => {
      throw new Error("secret URL");
    }) as typeof fetch,
  });
  assert.equal(
    (await new AgenticDriver({ providers: [broken] }).discoverProviders())[0]!
      .health!.code,
    "PROVIDER_UNREACHABLE",
  );
  const loop = anthropic({
    apiKey: "test",
    fetch: (async () =>
      reply({
        data: [{ id: "a" }],
        has_more: true,
        last_id: "a",
      })) as typeof fetch,
  });
  assert.equal(
    (await new AgenticDriver({ providers: [loop] }).discoverProviders())[0]!
      .health!.code,
    "INVALID_DISCOVERY_RESPONSE",
  );
});

test("API discovery reports partial inventories at page and model limits", async () => {
  let pages = 0;
  const manyPages = anthropic({
    apiKey: "test",
    fetch: (async () => {
      pages++;
      return reply({
        data: [{ id: `model-${pages}` }],
        has_more: true,
        last_id: `model-${pages}`,
      });
    }) as typeof fetch,
  });
  const [partial] = await new AgenticDriver({
    providers: [manyPages],
  }).discoverProviders();
  assert.equal(pages, 20);
  assert.equal(partial!.modelCatalog!.models.length, 20);
  assert.equal(partial!.modelCatalog!.complete, false);
  const manyModels = openai({
    apiKey: "test",
    fetch: (async () =>
      reply({
        data: Array.from({ length: 1001 }, (_, i) => ({ id: `model-${i}` })),
      })) as typeof fetch,
  });
  const [capped] = await new AgenticDriver({
    providers: [manyModels],
  }).discoverProviders();
  assert.equal(capped!.health!.status, "ready");
  assert.equal(capped!.modelCatalog!.models.length, 1000);
  assert.equal(capped!.modelCatalog!.complete, false);
});

test(
  "CLI discovery reports missing binaries, unsupported versions and local login status without generation",
  { skip: process.platform === "win32" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenticdriver-discovery-test-"));
    const binary = join(dir, "fake-cli"),
      log = join(dir, "invocations.jsonl");
    try {
      await writeFile(
        binary,
        `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
const account = process.env.CODEX_HOME || process.env.CLAUDE_CONFIG_DIR || '';
if (args.includes('--help')) {
  console.log(account.endsWith('old') ? 'old version' : '--ignore-user-config --ignore-rules --strict-config --ephemeral --sandbox --json --restricted --safe-mode --strict-mcp-config --tools --admin-policy --output-format --extensions');
} else if (args[1] === 'status' && ['login', 'auth'].includes(args[0])) {
  console.log('private-account@example.com secret-key');
  process.exitCode = account.endsWith('logged-out') ? 1 : 0;
} else { process.exitCode = 9; }
`,
        { mode: 0o700 },
      );
      const driver = new AgenticDriver({
        providers: [
          codex({ id: "missing", binary: join(dir, "not-installed") }),
          codex({ id: "old", binary, accountDirectory: join(dir, "old") }),
          codex({
            id: "codex-in",
            binary,
            accountDirectory: join(dir, "logged-in"),
            models: ["configured-model"],
          }),
          claudeCode({
            id: "claude-out",
            binary,
            accountDirectory: join(dir, "logged-out"),
          }),
          geminiCli({ id: "gemini-unknown", binary }),
        ],
      });
      const result = await driver.discoverProviders();
      assert.deepEqual(
        result.map((p) => p.health!.code),
        [
          "CLI_UNAVAILABLE",
          "CLI_UPGRADE_REQUIRED",
          "CLI_SESSION_PRESENT",
          "CLI_AUTH_REQUIRED",
          "CLI_STATUS_UNKNOWN",
        ],
      );
      assert.equal(result[2]!.health!.status, "unknown");
      assert.deepEqual(result[2]!.modelCatalog, {
        source: "configured",
        models: ["configured-model"],
        complete: false,
      });
      assert.doesNotMatch(
        JSON.stringify(result),
        /secret-key|private-account|fake-cli/,
      );
      const calls = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert.equal(calls.length, 6);
      assert(
        calls.every((args) => args.includes("--help") || args[1] === "status"),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
