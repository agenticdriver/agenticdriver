import assert from "node:assert/strict";
import test from "node:test";
import {
  codexAccount,
  claudeAccount,
  cliVersion,
} from "../src/providers/connection-metadata.js";
import { AgenticDriver } from "../src/driver.js";
import { AgenticClient } from "../src/client.js";
import { mockProvider } from "../src/providers/mock.js";
import { serve } from "../src/server.js";
import type { ProviderInspection } from "../src/types.js";

test("native status exposes only bounded reported fields and never interprets keys as subscriptions", () => {
  assert.deepEqual(
    codexAccount({
      account: {
        type: "chatgpt",
        email: "fixture@example.invalid",
        planType: "pro",
        token: "private",
      },
      workspaceRouting: { chatgptAccountId: "private" },
    }),
    {
      status: "signed-in",
      method: "ChatGPT",
      email: "fixture@example.invalid",
      subscription: "pro",
    },
  );
  assert.deepEqual(
    codexAccount({
      account: { type: "apiKey", email: "ignored", planType: "ignored" },
    }),
    { status: "signed-in", method: "API key" },
  );
  assert.deepEqual(codexAccount({ account: null }), { status: "signed-out" });
  assert.equal(
    codexAccount({ account: { type: "chatgpt", email: "control\nvalue" } }),
    undefined,
  );
  assert.deepEqual(
    claudeAccount(
      JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        subscriptionType: "pro",
        email: "fixture@example.invalid",
        orgId: "private",
        orgName: "private",
        configDirectory: "private",
        accessToken: "private",
      }),
      true,
    ),
    {
      status: "signed-in",
      method: "claude.ai",
      email: "fixture@example.invalid",
      subscription: "pro",
    },
  );
  assert.deepEqual(
    claudeAccount(
      JSON.stringify({ loggedIn: false, email: "old@example.invalid" }),
      false,
    ),
    { status: "signed-out" },
  );
  assert.deepEqual(claudeAccount("raw stderr or secret key", true), {
    status: "signed-in",
  });
  assert.deepEqual(
    claudeAccount(
      JSON.stringify({ loggedIn: false, email: "old@example.invalid" }),
      true,
    ),
    { status: "signed-in" },
  );
  assert.equal(cliVersion("codex", "secret on stderr"), undefined);
  assert.deepEqual(cliVersion("claude-code", "2.1.283 (Claude Code)\n"), {
    name: "Claude Code",
    version: "2.1.283",
  });
});

test("connection metadata follows provider grants, strips extra fields and clears on failed refresh", async () => {
  let fail = false,
    hidden = 0,
    calls = 0;
  const visible = {
    ...mockProvider(),
    info: { ...mockProvider().info, id: "visible" },
    inspect: async (): Promise<ProviderInspection> => {
      calls++;
      if (fail) throw new Error("private failure");
      return {
        code: "CLI_SESSION_PRESENT",
        connection: {
          source: "native-runtime",
          runtime: { name: "Fixture CLI", version: "1.0.0" },
          account: {
            status: "signed-in",
            name: "Synthetic Person",
            email: "fixture@example.invalid",
            subscription: "Example",
            token: "private",
          },
        },
      } as ProviderInspection;
    },
  };
  const privateProvider = {
    ...mockProvider(),
    info: { ...mockProvider().info, id: "hidden" },
    inspect: async (): Promise<ProviderInspection> => {
      hidden++;
      throw new Error("unreachable");
    },
  };
  const driver = new AgenticDriver({
    providers: [visible, privateProvider],
    discovery: { cacheTtlMs: 10000, minRefreshMs: 0 },
  });
  const credential = "provider-connection-fixture-token-at-least-32-characters";
  const server = await serve(driver, {
    port: 0,
    tokens: [{ token: credential, subject: "fixture", providers: ["visible"] }],
  });
  try {
    const client = new AgenticClient({ url: server.url, token: credential });
    const first = (await client.providers())[0]!;
    assert.equal(first.connection?.account?.email, "fixture@example.invalid");
    assert.equal(first.connection?.source, "native-runtime");
    assert.ok(first.connection?.checkedAt);
    assert.doesNotMatch(JSON.stringify(first), /token|private/);
    assert.equal(first.health?.status, "unknown");
    first.connection!.account!.email = "mutated";
    assert.equal(
      (await client.providers())[0]!.connection?.account?.email,
      "fixture@example.invalid",
    );
    assert.equal(calls, 1);
    fail = true;
    const refreshed = (await client.providers({ refresh: true }))[0]!;
    assert.equal(refreshed.connection, undefined);
    assert.equal(refreshed.health?.code, "DISCOVERY_FAILED");
    assert.equal(hidden, 0);
  } finally {
    await server.close();
  }
});
