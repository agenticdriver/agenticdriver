import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { claudeCode } from "../src/providers/local-cli.js";
import { HostProviderConfigSchema } from "../src/provider-config.js";
import { configuredDriver, validateHostConfig } from "../src/host.js";
import { managedHost } from "../src/management.js";

const native = {
  kind: "claude-code" as const,
  id: "selected-native",
  accountId: "native-account",
  accountDirectory: "/private/native-profile",
};
const api = {
  kind: "claude-code" as const,
  id: "selected-api",
  accountId: "api-account",
  apiKeyRef: { env: "EXPLICIT_ANTHROPIC_KEY" },
};

test("Claude API mode is explicit and cannot combine with a native account profile", () => {
  assert.equal(HostProviderConfigSchema.safeParse(native).success, true);
  assert.equal(HostProviderConfigSchema.safeParse(api).success, true);
  assert.equal(
    HostProviderConfigSchema.safeParse({
      ...api,
      accountDirectory: "/private/native-profile",
    }).success,
    false,
  );
  assert.equal(
    HostProviderConfigSchema.safeParse({
      ...api,
      baseUrl: "https://unselected.example",
    }).success,
    false,
  );
  assert.throws(() => claudeCode({ apiKey: undefined } as never), {
    code: "INVALID_CONFIG",
  });
  assert.throws(
    () =>
      claudeCode({
        apiKey: "",
        accountDirectory: "/private/native-profile",
      } as never),
    { code: "INVALID_CONFIG" },
  );
  assert.equal(claudeCode().info.authMode, "cli-session");
  assert.equal(claudeCode({ apiKey: "" }).info.authMode, "api-key");
  assert.notEqual(claudeCode().info.id, claudeCode({ apiKey: "" }).info.id);
});

test("an empty explicit API credential fails before any native process, without a session fallback", async () => {
  let resolutions = 0;
  const provider = claudeCode({
    binary: "/no-native-process-can-start",
    apiKey: () => {
      resolutions++;
      return "";
    },
  });
  assert.equal(resolutions, 0);
  const inspected = await provider.inspect!({
    signal: new AbortController().signal,
  });
  assert.equal(inspected.code, "AUTH_REQUIRED");
  assert.equal(resolutions, 1);
  await assert.rejects(
    provider.complete(
      {
        model: "explicit-model",
        messages: [
          {
            role: "user",
            content: "Draft a release email from selected public notes.",
          },
        ],
        tools: [],
        maxOutputTokens: 128,
      },
      {
        runId: "negative-control",
        subject: "control",
        signal: new AbortController().signal,
        emitText() {},
        reportProgress() {},
      },
    ),
    { code: "AUTH_REQUIRED" },
  );
  assert.equal(resolutions, 2);
});

test("cancelling an explicit credential resolution never starts a native fallback", async () => {
  const controller = new AbortController();
  let entered!: () => void;
  const resolving = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const provider = claudeCode({
    binary: "/no-native-process-can-start",
    apiKey: () => {
      entered();
      return new Promise<string>(() => {});
    },
  });
  const cancelled = new Error("Caller cancelled credential resolution");
  const operation = provider.inspect!({ signal: controller.signal });
  await resolving;
  controller.abort(cancelled);
  await assert.rejects(operation, (error) => error === cancelled);
});

test("constructing an API-native host never resolves its configured credential", () => {
  const driver = configuredDriver(
    validateHostConfig({
      version: 1,
      usage: { hostId: "configuration-test" },
      providers: [api],
    }),
    "/private/config.json",
    {
      secrets: async () => {
        throw new Error("Setup must not resolve a credential");
      },
    },
  );
  assert.equal(driver.listProviders()[0]!.authMode, "api-key");
  assert.equal(driver.listProviders()[0]!.vendor, "claude-code");
});

test("management cannot change an existing Claude instance between native and API billing", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-api-mode-")),
    path = join(root, "config.json");
  try {
    for (const [before, after] of [
      [native, { ...api, id: native.id, accountId: native.accountId }],
      [api, { ...native, id: api.id, accountId: api.accountId }],
    ]) {
      const raw = JSON.stringify({
        version: 1,
        usage: { hostId: "configuration-test" },
        providers: [before],
      });
      await writeFile(path, raw, { mode: 0o600 });
      const runtime = await managedHost(path);
      const snapshot = await runtime.management.snapshot();
      await assert.rejects(
        runtime.management.configure({
          revision: snapshot.revision,
          provider: after,
        }),
        { code: "PROVIDER_IDENTITY_CHANGED" },
      );
      assert.equal(await readFile(path, "utf8"), raw);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI init explicitly selects API-native mode and refuses account-directory ambiguity", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const run = promisify(execFile),
    cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const root = await mkdtemp(join(tmpdir(), "claude-api-init-"));
  try {
    const path = join(root, "api", "host.json");
    await run(process.execPath, [
      "--import",
      "tsx",
      cli,
      "init",
      "--provider",
      "claude-code",
      "--api-key-env",
      "EXPLICIT_ANTHROPIC_KEY",
      "--config",
      path,
      "--json",
    ]);
    const config = JSON.parse(await readFile(path, "utf8"));
    assert.equal(config.providers[0].id, "claude-code-api");
    assert.deepEqual(config.providers[0].apiKeyRef, {
      env: "EXPLICIT_ANTHROPIC_KEY",
    });
    assert.equal(Object.hasOwn(config.providers[0], "accountDirectory"), false);
    const deniedPath = join(root, "denied", "host.json");
    await assert.rejects(
      run(process.execPath, [
        "--import",
        "tsx",
        cli,
        "init",
        "--provider",
        "claude-code",
        "--api-key-env",
        "EXPLICIT_ANTHROPIC_KEY",
        "--account-directory",
        "/private/native-profile",
        "--config",
        deniedPath,
        "--json",
      ]),
    );
    await assert.rejects(readFile(deniedPath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
