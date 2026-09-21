// Installed-package fixture. The real Better Auth + AuthYard recipe is in docs/authentication.md.
import assert from "node:assert/strict";
import { AgenticDriver } from "agenticdriver";
import { AgenticClient } from "agenticdriver/client";
import { serve } from "agenticdriver/server";
import {
  betterAuthAuthentication,
  type BetterAuthIdentity,
} from "agenticdriver/better-auth";
import { mockProvider } from "agenticdriver/providers";

const issuer = "https://app.example.test/api/auth";
const resource = "https://driver.example.test";
let currentToken = "synthetic-access-token-one";
const authentication = betterAuthAuthentication({
  issuer,
  resource,
  clientId: "resource-host",
  clientSecret: () => "synthetic-introspection-secret",
  scopes: { "driver:read": { providers: ["mock"] } },
  resolveGrant: async (identity: BetterAuthIdentity) =>
    identity.clientId === "device" && identity.userId === "user"
      ? { id: "device-grant", subject: "app-user", scopes: ["driver:read"] }
      : undefined,
  // Synthetic transport only; production uses native Better Auth introspection.
  fetch: async (_url, init) =>
    Response.json(
      new URLSearchParams(String(init?.body)).get("token") === currentToken
        ? {
            active: true,
            iss: issuer,
            aud: resource,
            client_id: "device",
            sub: "user",
            exp: Math.floor(Date.now() / 1000) + 300,
            scope: "driver:read",
            token_type: "Bearer",
          }
        : { active: false },
    ),
});
const host = await serve(new AgenticDriver({ providers: [mockProvider()] }), {
  authentication,
  port: 0,
});
try {
  const client = new AgenticClient({
    url: host.url,
    token: () => currentToken,
  });
  assert.equal((await client.providers())[0]?.id, "mock");
  currentToken = "synthetic-access-token-two";
  assert.equal((await client.providers())[0]?.id, "mock");
  await assert.rejects(
    new AgenticClient({
      url: host.url,
      token: "synthetic-access-token-one",
    }).providers(),
    { code: "UNAUTHORIZED" },
  );
  console.log(
    "Installed auth types, scoped host and rotated credential resolver passed",
  );
} finally {
  await host.close();
}
