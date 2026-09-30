import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { managedHost } from "../src/management.js";
import { configuredServer } from "../src/host.js";
import { serve } from "../src/server.js";
import { AgenticClient } from "../src/client.js";
import {
  ProviderRuntimeRequestSchema,
  ProviderRuntimeSnapshotSchema,
  matchesRuntimeResponse,
} from "../src/runtime-types.js";
import { providerRuntimes } from "../src/provider-runtimes.js";

test("runtime requests reject caller-selected downloads, paths and versions", () => {
  for (const extra of [
    { url: "https://example.com/archive" },
    { binary: "/tmp/file" },
    { version: "latest" },
    { directory: "/tmp" },
    { accountDirectory: "/tmp" },
    { token: "secret" },
  ]) {
    assert.equal(
      ProviderRuntimeRequestSchema.safeParse({
        action: "install",
        kind: "codex",
        ...extra,
      }).success,
      false,
    );
  }
  assert.equal(
    ProviderRuntimeRequestSchema.safeParse({
      action: "install",
      kind: "claude-code",
    }).success,
    false,
  );
  assert.equal(
    ProviderRuntimeRequestSchema.safeParse({ action: "cancel", kind: "codex" })
      .success,
    false,
  );
});

test("runtime response contracts reject premature paths, overflow and mismatched cancellation", () => {
  const status = {
    version: 1,
    runtimes: [
      {
        kind: "codex",
        version: "0.157.0",
        platform: "linux-x64",
        phase: "missing",
        archiveSha256: "a".repeat(64),
        downloadBytes: 0,
        totalBytes: 100,
        canCancel: false,
      },
    ],
  };
  const parsed = ProviderRuntimeSnapshotSchema.parse(status);
  assert.ok(
    matchesRuntimeResponse(parsed, { action: "status", kind: "codex" }),
  );
  for (const change of [
    { binary: "/tmp/premature" },
    { downloadBytes: 101 },
    { canCancel: true },
    { phase: "installed" },
    { phase: "downloading" },
  ]) {
    const changed = ProviderRuntimeSnapshotSchema.parse({
      ...status,
      runtimes: [{ ...status.runtimes[0], ...change }],
    });
    assert.equal(
      matchesRuntimeResponse(changed, { action: "status", kind: "codex" }),
      false,
    );
  }
  assert.equal(
    matchesRuntimeResponse(parsed, {
      action: "cancel",
      kind: "codex",
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }),
    false,
  );
});

test(
  "actual empty host advertises runtime management only to administrators; status downloads nothing",
  { skip: process.platform !== "linux" || process.arch !== "x64" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "driver-runtime-empty-"));
    let server: Awaited<ReturnType<typeof serve>> | undefined;
    try {
      const path = join(directory, "config.json"),
        operator = randomBytes(32).toString("hex"),
        reader = randomBytes(32).toString("hex");
      await writeFile(join(directory, "operator.token"), operator, {
        mode: 0o600,
      });
      await writeFile(join(directory, "reader.token"), reader, { mode: 0o600 });
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          listen: { port: 0 },
          providers: [],
          tokens: [
            {
              id: "operator",
              subject: "runtime-operator",
              providers: [],
              manageProviders: true,
              tokenRef: { file: join(directory, "operator.token") },
            },
            {
              id: "reader",
              subject: "runtime-reader",
              providers: [],
              tokenRef: { file: join(directory, "reader.token") },
            },
          ],
        }),
        { mode: 0o600 },
      );
      const host = await managedHost(path);
      server = await serve(host.driver, {
        ...(await configuredServer(host.config(), path)),
        management: host.management,
        connections: host.connections,
      });
      const admin = new AgenticClient({ url: server.url, token: operator }),
        app = new AgenticClient({ url: server.url, token: reader });
      assert.ok(
        (await admin.protocol()).features.includes("provider-runtimes"),
      );
      assert.equal(
        (await app.protocol()).features.includes("provider-runtimes"),
        false,
      );
      const result = await admin.providerRuntime({
        action: "status",
        kind: "codex",
      });
      assert.equal(result.runtimes[0]!.phase, "missing");
      assert.equal(result.runtimes[0]!.binary, undefined);
      assert.deepEqual(await readdir(join(directory, "provider-runtimes")), []);
      assert.deepEqual((await admin.management()).providers, []);
      await assert.rejects(
        app.providerRuntime({ action: "install", kind: "codex" }),
        { code: "FORBIDDEN" },
      );
      assert.deepEqual(await readdir(join(directory, "provider-runtimes")), []);
    } finally {
      await server?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "runtime initialization rejects a symlink store without touching its destination",
  { skip: process.platform !== "linux" || process.arch !== "x64" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "driver-runtime-unsafe-")),
      destination = await mkdtemp(
        join(tmpdir(), "driver-runtime-destination-"),
      );
    try {
      await symlink(destination, join(directory, "provider-runtimes"));
      await assert.rejects(providerRuntimes({ directory }), {
        code: "RUNTIME_STORE_UNSAFE",
      });
      assert.deepEqual(await readdir(destination), []);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(destination, { recursive: true, force: true });
    }
  },
);
