import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { configuredDriver, validateHostConfig } from "../src/host.js";

test("Antigravity host construction preserves native selection and refuses application tools before execution", () => {
  const driver = configuredDriver(
    validateHostConfig({
      version: 1,
      providers: [
        {
          id: "selected-agy",
          kind: "antigravity",
          binary: "/no-process-may-start",
          accountDirectory: "/selected/native/profile",
          models: ["gemini-3.8-flash-low"],
        },
      ],
    }),
    "/private/host.json",
    {
      secrets: async () => {
        throw new Error("No API credential may be resolved");
      },
    },
  );
  const info = driver.listProviders()[0]!;
  assert.equal(info.id, "selected-agy");
  assert.equal(info.authMode, "cli-session");
  assert.deepEqual(info.models, ["gemini-3.8-flash-low"]);
  assert.throws(
    () =>
      driver.validate({
        provider: info.id,
        model: "gemini-3.8-flash-low",
        input:
          "Read the selected product brief and draft three brand directions.",
        tools: ["read_brief"],
      }),
    { code: "UNSUPPORTED_TOOLS" },
  );
});

test("CLI init stores an explicit Antigravity native route without starting the runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agy-init-"));
  try {
    const configPath = join(directory, "host.json");
    await promisify(execFile)(process.execPath, [
      "--import",
      "tsx",
      fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
      "init",
      "--provider",
      "antigravity",
      "--provider-id",
      "selected-agy",
      "--model",
      "gemini-3.8-flash-low",
      "--binary",
      "/no-process-may-start",
      "--account-directory",
      "/selected/native/profile",
      "--config",
      configPath,
      "--json",
    ]);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(saved.providers, [
      {
        kind: "antigravity",
        id: "selected-agy",
        models: ["gemini-3.8-flash-low"],
        binary: "/no-process-may-start",
        accountDirectory: "/selected/native/profile",
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing selected Antigravity sign-in is actionable without resolving another account", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agy-missing-account-"));
  try {
    const { antigravity } = await import("../src/providers/index.js");
    const provider = antigravity({
      binary: process.execPath,
      accountDirectory: directory,
    });
    const result = await provider.inspect!({
      signal: new AbortController().signal,
    });
    assert.equal(result.code, "CLI_AUTH_REQUIRED");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
