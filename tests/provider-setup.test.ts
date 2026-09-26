import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgenticClient } from "../src/client.js";
import { AgenticDriver } from "../src/driver.js";
import { DriverError } from "../src/errors.js";
import { providerSetup } from "../src/provider-setup.js";
import { mockProvider } from "../src/providers/mock.js";
import { serve } from "../src/server.js";
import type {
  ManagementSnapshot,
  ConfigureProvider,
} from "../src/management-types.js";
import type {
  codexDeviceSignIn,
  NativeSignInAccount,
} from "../src/providers/codex-sign-in.js";

async function fixture(nativeOverride?: typeof codexDeviceSignIn) {
  const directory = await mkdtemp(join(tmpdir(), "driver-owned-setup-"));
  let state: ManagementSnapshot = {
    version: 1,
    revision: "a".repeat(64),
    providers: [{ kind: "mock", id: "existing", accountId: "shared" }],
    supportedKinds: ["codex", "mock"],
  };
  const pending: {
    options: Parameters<typeof codexDeviceSignIn>[0];
    resolve(account: NativeSignInAccount): void;
    reject(error: Error): void;
  }[] = [];
  const configure = async (input: unknown) => {
    const change = input as ConfigureProvider;
    assert.equal(change.revision, state.revision);
    state = {
      ...state,
      revision: "b".repeat(64),
      providers: [...state.providers, change.provider],
    };
    return structuredClone(state);
  };
  const snapshot = () => structuredClone(state);
  const setup = await providerSetup({
    directory,
    snapshot,
    configure,
    native:
      nativeOverride ??
      ((options) =>
        new Promise((resolve, reject) => {
          pending.push({ options, resolve, reject });
          options.signal.addEventListener(
            "abort",
            () => reject(new Error("owned process cancelled")),
            { once: true },
          );
          options.interaction({
            type: "device-code",
            verificationUrl: "https://auth.openai.com/codex/device",
            userCode: "AAAA-BBBB",
          });
        })),
  });
  return {
    directory,
    pending,
    setup,
    snapshot,
    configure,
    start: (caller = "operator", id = "new-account") =>
      setup.request(
        {
          action: "start",
          revision: state.revision,
          method: "codex-device",
          provider: { kind: "codex", id, accountId: "explicit-account" },
        },
        caller,
      ),
    change: () => {
      state.revision = "c".repeat(64);
    },
    close: async () => {
      await setup.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
async function phase(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  expected: string,
) {
  for (let i = 0; i < 100; i++) {
    const result = await f.setup.request({ action: "status", id }, "operator");
    if (result.attempts[0]!.phase === expected) return result.attempts[0]!;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`setup did not reach ${expected}`);
}

test("owned sign-in requires native verification and explicit acceptance; credentials and model grants stay separate", async () => {
  const f = await fixture();
  try {
    const { id } = (await f.start()).attempts[0]!;
    const waiting = await phase(f, id, "waiting");
    assert.equal(waiting.account, undefined);
    await assert.rejects(
      f.setup.request({ action: "accept", id }, "operator"),
      { code: "SETUP_NOT_READY" },
    );
    const owned = f.pending[0]!.options.accountDirectory;
    assert.equal((await stat(owned)).mode & 0o077, 0);
    await writeFile(
      join(owned, "auth.json"),
      "synthetic-native-owned-credential",
      { mode: 0o600 },
    );
    f.pending[0]!.options.verifying();
    f.pending[0]!.resolve({
      email: "fixture@example.invalid",
      plan: "pro",
      providerAccountId: "provider-account",
    });
    const ready = await phase(f, id, "ready");
    assert.equal(ready.account?.email, "fixture@example.invalid");
    assert.equal(f.snapshot().providers.length, 1);
    assert.ok(!JSON.stringify(ready).includes(owned));
    assert.ok(
      !JSON.stringify(ready).includes("synthetic-native-owned-credential"),
    );
    const accepted = await f.setup.request(
      { action: "accept", id },
      "operator",
    );
    assert.equal(accepted.attempts[0]!.phase, "succeeded");
    const provider = f.snapshot().providers[1]!;
    assert.equal(provider.kind === "codex" && provider.accountDirectory, owned);
    assert.equal(provider.accountId, "explicit-account");
    assert.equal(provider.models, undefined);
    assert.deepEqual(f.snapshot().providers[0], {
      kind: "mock",
      id: "existing",
      accountId: "shared",
    });
    await assert.rejects(
      f.setup.request({ action: "accept", id }, "operator"),
      { code: "SETUP_FINISHED" },
    );
    await assert.rejects(f.start(), { code: "SETUP_NEW_INSTANCE_REQUIRED" });
    await f.setup.close();
    assert.equal(
      await readFile(join(owned, "auth.json"), "utf8"),
      "synthetic-native-owned-credential",
    );
  } finally {
    await f.close();
  }
});

test("attempts are opaque, caller-bound, immutable and cancelled without touching shared profiles", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, "shared-account"), "keep");
    const { id } = (await f.start()).attempts[0]!;
    await phase(f, id, "waiting");
    assert.deepEqual(
      (await f.setup.request({ action: "list" }, "other")).attempts,
      [],
    );
    for (const action of ["status", "accept", "cancel"])
      await assert.rejects(f.setup.request({ action, id }, "other"), {
        code: "SETUP_NOT_FOUND",
      });
    await assert.rejects(
      f.setup.request(
        { action: "accept", id, accountId: "replacement" },
        "operator",
      ),
      { code: "INVALID_SETUP_REQUEST" },
    );
    await assert.rejects(f.start("other"), {
      code: "SETUP_NEW_INSTANCE_REQUIRED",
    });
    assert.equal(
      (await f.setup.request({ action: "cancel", id }, "operator")).attempts[0]!
        .phase,
      "cancelled",
    );
    assert.ok(f.pending[0]!.options.signal.aborted);
    assert.deepEqual(await readdir(join(f.directory, "provider-accounts")), []);
    assert.equal(
      await readFile(join(f.directory, "shared-account"), "utf8"),
      "keep",
    );
    await assert.rejects(
      f.setup.request({ action: "cancel", id }, "operator"),
      { code: "SETUP_FINISHED" },
    );
  } finally {
    await f.close();
  }
});

test("stale and expired attempts cannot publish; shutdown cancels remaining native work", async (t) => {
  const f = await fixture();
  try {
    const first = (await f.start()).attempts[0]!;
    await phase(f, first.id, "waiting");
    f.change();
    const stale = await phase(f, first.id, "failed");
    assert.equal(stale.error?.code, "CONFIG_CONFLICT");
    assert.ok(f.pending[0]!.options.signal.aborted);
    const second = (await f.start()).attempts[0]!;
    await phase(f, second.id, "waiting");
    t.mock.timers.enable({
      apis: ["Date"],
      now: Date.parse(second.expiresAt) + 1,
    });
    assert.equal(
      (await phase(f, second.id, "expired")).error?.code,
      "SETUP_EXPIRED",
    );
    t.mock.timers.reset();
    const third = (await f.start()).attempts[0]!;
    await phase(f, third.id, "waiting");
    await f.setup.close();
    assert.ok(f.pending[2]!.options.signal.aborted);
    assert.deepEqual(await readdir(join(f.directory, "provider-accounts")), []);
    assert.equal(f.snapshot().providers.length, 1);
    await assert.rejects(f.start(), { code: "SETUP_UNAVAILABLE" });
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});

test("synchronous native failures are redacted and clean their new private profile", async () => {
  const f = await fixture(() => {
    throw new Error("private provider error / token");
  });
  try {
    const { id } = (await f.start()).attempts[0]!;
    const result = await phase(f, id, "failed");
    assert.equal(result.error?.code, "SETUP_FAILED");
    assert.ok(!JSON.stringify(result).includes("private provider error"));
    assert.deepEqual(await readdir(join(f.directory, "provider-accounts")), []);
  } finally {
    await f.close();
  }
});

test("host transport gates setup by management and binds attempts to the actual credential", async () => {
  const f = await fixture();
  const token = (name: string) =>
    `${name}-test-credential-at-least-32-characters`;
  const adapter = mockProvider();
  adapter.info.id = "existing";
  const driver = new AgenticDriver({ providers: [adapter] });
  const server = await serve(driver, {
    port: 0,
    management: {
      snapshot: f.snapshot,
      configure: f.configure,
      setup: f.setup,
    },
    tokens: [
      {
        token: token("owner"),
        subject: "same-subject",
        providers: [],
        manageProviders: true,
      },
      {
        token: token("other"),
        subject: "same-subject",
        providers: [],
        manageProviders: true,
      },
      { token: token("app"), subject: "app", providers: ["existing"] },
    ],
  });
  try {
    const client = (name: string) =>
      new AgenticClient({ url: server.url, token: token(name) });
    const owner = client("owner"),
      other = client("other"),
      app = client("app");
    assert.ok((await owner.protocol()).features.includes("provider-setup"));
    assert.ok(!(await app.protocol()).features.includes("provider-setup"));
    await assert.rejects(app.providerSetup({ action: "list" }), {
      code: "FORBIDDEN",
    });
    const { id } = (
      await owner.providerSetup({
        action: "start",
        method: "codex-device",
        revision: f.snapshot().revision,
        provider: { kind: "codex", id: "new", accountId: "explicit" },
      })
    ).attempts[0]!;
    await assert.rejects(other.providerSetup({ action: "cancel", id }), {
      code: "SETUP_NOT_FOUND",
    });
    assert.deepEqual(
      (await other.providerSetup({ action: "list" })).attempts,
      [],
    );
    await owner.providers({ refresh: true });
    assert.equal(f.pending[0]!.options.signal.aborted, false);
    await assert.rejects(
      owner.run({ provider: "existing", model: "demo", input: "synthetic" }),
      { code: "FORBIDDEN" },
    );
    assert.equal(
      (
        await app.run({
          provider: "existing",
          model: "demo",
          input: "synthetic",
        })
      ).text,
      "AgenticDriver is connected.",
    );
    await owner.providerSetup({ action: "cancel", id });
    await assert.rejects(owner.providerSetup({ action: "cancel", id }), {
      code: "SETUP_FINISHED",
    });
  } finally {
    await server.close();
    await f.close();
  }
});

test("configuration preflight rejects before starting a credential interaction", async () => {
  const f = await fixture();
  let called = false;
  const setup = await providerSetup({
    directory: f.directory,
    snapshot: f.snapshot,
    configure: f.configure,
    preflight: async () => {
      throw new DriverError("CONFIG_CONFLICT", "Refresh settings.");
    },
    native: async () => {
      called = true;
      throw new Error("unreachable");
    },
  });
  try {
    await assert.rejects(
      setup.request(
        {
          action: "start",
          method: "codex-device",
          revision: f.snapshot().revision,
          provider: { kind: "codex", id: "new", accountId: "explicit" },
        },
        "owner",
      ),
      { code: "CONFIG_CONFLICT" },
    );
    assert.equal(called, false);
    assert.deepEqual(await readdir(join(f.directory, "provider-accounts")), []);
  } finally {
    await setup.close();
    await f.close();
  }
});
