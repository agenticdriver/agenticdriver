// Test-only real Better Auth/AuthYard application and synthetic model endpoint.
// This image is not published and is never the production auth service.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as tlsServer } from "node:https";
import { readFile, writeFile, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { toNodeHandler } from "better-auth/node";
import { oauthProvider } from "@better-auth/oauth-provider";
import { controlPlane } from "@authplane/better-auth";

const origin = "https://127.0.0.1:7451";
const resource = "https://driver.example.test";
const state = { requests: 0, completed: 0, cancelled: 0 };
const key = "ap_v1_" + "a".repeat(43);
const providerKey = "synthetic-deployment-model-key";
const writeJSON = async (path, value) => {
  await writeFile(path + ".tmp", JSON.stringify(value), { mode: 0o600 });
  await rename(path + ".tmp", path);
};
let recorded = Promise.resolve();
const record = () => {
  const snapshot = { ...state };
  recorded = recorded.then(() =>
    writeJSON("/fixture-output/metrics.json", snapshot),
  );
};
const management = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, "Bearer " + key);
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/internal/credentials/verify")
    res.end(
      JSON.stringify({
        projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    );
  else if (req.url === "/internal/events") {
    let body = "";
    for await (const part of req) body += part;
    res.end(
      JSON.stringify({
        acceptedIds: JSON.parse(body).events.map((event) => event.id),
      }),
    );
  } else {
    res.writeHead(404);
    res.end("{}");
  }
});
await new Promise((resolve) => management.listen(7450, "127.0.0.1", resolve));
const connector = controlPlane({
  url: "http://127.0.0.1:7450",
  projectKey: key,
  allowInsecureHttp: true,
  events: { flushIntervalMs: 0 },
});
const db = new DatabaseSync("/tmp/auth.sqlite");
const auth = betterAuth({
  database: db,
  baseURL: origin,
  secret: randomBytes(48).toString("base64url"),
  emailAndPassword: { enabled: true },
  trustedOrigins: [origin],
  telemetry: { enabled: false },
  logger: { disabled: true },
  rateLimit: { enabled: false },
  plugins: [
    oauthProvider({
      disableJwtPlugin: true,
      loginPage: "/login",
      consentPage: "/consent",
      scopes: ["driver:fixture"],
      grantTypes: ["client_credentials"],
      resources: [
        {
          identifier: resource,
          allowedScopes: ["driver:fixture"],
          accessTokenTtl: 300,
        },
      ],
      clientRegistrationDefaultResources: [resource],
      clientPrivileges: ({ user }) => Boolean(user),
    }),
    connector,
  ],
});
await (await getMigrations(auth.options)).runMigrations();
await auth.$context;
const signup = await auth.handler(
  new Request(origin + "/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({
      email: "fixture@example.test",
      name: "Fixture",
      password: "synthetic-deployment-password",
    }),
  }),
);
assert.equal(signup.status, 200);
const cookie = signup.headers
  .getSetCookie()
  .map((value) => value.split(";")[0])
  .join("; ");
await signup.body.cancel();
const headers = new Headers({ Cookie: cookie, Origin: origin });
const introspection = await auth.api.createOAuthClient({
  headers,
  body: {
    client_name: "Driver resource",
    token_endpoint_auth_method: "client_secret_basic",
    grant_types: ["client_credentials"],
    scope: "driver:fixture",
  },
});
const service = await auth.api.adminCreateOAuthClient({
  headers,
  body: {
    client_name: "Application backend",
    token_endpoint_auth_method: "client_secret_basic",
    grant_types: ["client_credentials"],
    scope: "driver:fixture",
    client_credentials_scopes: ["driver:fixture"],
  },
});
const issued = await auth.handler(
  new Request(origin + "/api/auth/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " +
        Buffer.from(service.client_id + ":" + service.client_secret).toString(
          "base64",
        ),
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      resource,
      scope: "driver:fixture",
    }),
  }),
);
assert.equal(issued.status, 200);
const credential = await issued.json();
await writeFile(
  "/fixture-secrets/oauth-introspection-secret",
  introspection.client_secret,
  { mode: 0o600 },
);
await writeFile("/fixture-secrets/provider-key", providerKey, { mode: 0o600 });
await writeJSON("/fixture-config/authorization.json", {
  version: 1,
  issuer: origin + "/api/auth",
  resource,
  clientId: introspection.client_id,
  clientSecretRef: { file: "/run/secrets/oauth-introspection-secret" },
  scopes: { "driver:fixture": { providers: ["fixture"] } },
  services: [
    {
      id: "fixture-backend",
      clientId: service.client_id,
      subject: "service:fixture",
      scopes: ["driver:fixture"],
    },
  ],
});
await writeJSON("/fixture-output/credential.json", {
  token: credential.access_token,
  expiresIn: credential.expires_in,
});
record();
await recorded;
let ready = false;
const handle = toNodeHandler(auth);
const application = tlsServer(
  {
    key: await readFile("/run/tls/server.key"),
    cert: await readFile("/run/tls/server.crt"),
  },
  (req, res) => {
    if (req.url === "/health") {
      res.writeHead(ready ? 200 : 503);
      res.end("ok");
    } else void handle(req, res);
  },
);
await new Promise((resolve) => application.listen(7451, "127.0.0.1", resolve));
const provider = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, "Bearer " + providerKey);
  if (req.method === "GET" && req.url === "/v1/models") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
    return;
  }
  assert.equal(req.method, "POST");
  assert.equal(req.url, "/v1/responses");
  let input = "";
  for await (const part of req) input += part;
  assert.equal(JSON.parse(input).model, "fixture-model");
  state.requests++;
  record();
  res.on("close", () => {
    if (!res.writableEnded) {
      state.cancelled++;
      record();
    }
  });
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.flushHeaders();
  res.write(
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Remote " })}\n\n`,
  );
  if (input.includes("hold-until-cancel")) return;
  const timer = setTimeout(() => {
    if (res.destroyed) return;
    res.write(
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "deployment works." })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Remote deployment works." }] }], usage: { input_tokens: 3, output_tokens: 4 } } })}\n\n`,
    );
    state.completed++;
    record();
    res.end();
  }, 200);
  res.once("close", () => clearTimeout(timer));
});
await new Promise((resolve) => provider.listen(7452, "127.0.0.1", resolve));
ready = true;
process.stdout.write("Synthetic auth and model fixture ready.\n");
await new Promise((resolve) => {
  process.once("SIGTERM", resolve);
  process.once("SIGINT", resolve);
});
ready = false;
for (const server of [provider, application, management]) {
  const stopped = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  await stopped;
}
await recorded;
await connector.close();
db.close();
