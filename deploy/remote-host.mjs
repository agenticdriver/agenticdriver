/** Backend-service deployment entry. Application user authorization belongs in the application's own host. */
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  configuredDriver,
  configuredServer,
  readHostConfig,
  secretResolver,
  SecretReferenceSchema,
} from "../dist/host.js";
import { serve } from "../dist/server.js";
import { betterAuthAuthentication } from "../dist/better-auth.js";
import { AccessPolicySchema } from "../dist/authorization.js";

const name = z.string().min(1).max(256);
const { subject: _subject, ...permissionFields } = AccessPolicySchema.shape;
const permissions = z
  .object(permissionFields)
  .strict()
  .refine(
    (value) =>
      AccessPolicySchema.safeParse({ ...value, subject: "service-policy" })
        .success,
  );
const authorizationSchema = z
  .object({
    version: z.literal(1),
    issuer: z.url(),
    resource: z.url(),
    clientId: name,
    clientSecretRef: SecretReferenceSchema,
    scopes: z.record(name, permissions),
    services: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            clientId: name,
            subject: z.string().min(1).max(128),
            scopes: z.array(name).max(256),
          })
          .strict(),
      )
      .min(1)
      .max(256),
  })
  .strict();
async function readAuthorization(path) {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 1_000_000)
      throw new Error("Invalid authorization file.");
    const result = authorizationSchema.safeParse(
      JSON.parse(await file.readFile("utf8")),
    );
    if (!result.success)
      throw new Error("Invalid authorization configuration.");
    const value = result.data;
    if (
      new Set(value.services.map((entry) => entry.id)).size !==
        value.services.length ||
      new Set(value.services.map((entry) => entry.clientId)).size !==
        value.services.length
    )
      throw new Error("Duplicate service authorization.");
    return value;
  } finally {
    await file.close();
  }
}
const configuration = resolve(
  process.env.AGENTICDRIVER_CONFIG ?? "/etc/agenticdriver/config.json",
);
const authorizationPath = resolve(
  process.env.AGENTICDRIVER_AUTHORIZATION ??
    "/etc/agenticdriver/authorization.json",
);
let host;
try {
  const config = await readHostConfig(configuration);
  if (
    config.tokens.length ||
    config.jobs ||
    config.listen.host !== "127.0.0.1" ||
    config.listen.port !== 7433 ||
    config.tls
  )
    throw new Error("Use the loopback service deployment configuration.");
  if (
    config.providers.some((provider) =>
      ["codex", "claude-code", "gemini-cli", "extension"].includes(
        provider.kind,
      ),
    )
  )
    throw new Error(
      "The stock remote image supports configured API and mock adapters.",
    );
  const policy = await readAuthorization(authorizationPath);
  for (const grant of Object.values(policy.scopes))
    if (
      grant.providers.some(
        (id) => !config.providers.some((provider) => provider.id === id),
      )
    )
      throw new Error("Unconfigured provider grant.");
  const secrets = secretResolver(dirname(authorizationPath));
  const authentication = betterAuthAuthentication({
    issuer: policy.issuer,
    resource: policy.resource,
    clientId: policy.clientId,
    clientSecret: () => secrets(policy.clientSecretRef),
    scopes: policy.scopes,
    resolveGrant: async (identity) => {
      // Service tokens must not be turned into their owner's user identity.
      if (identity.userId !== undefined) return undefined;
      const current = await readAuthorization(authorizationPath);
      if (
        current.issuer !== policy.issuer ||
        current.resource !== policy.resource ||
        current.clientId !== policy.clientId
      )
        return undefined;
      const grant = current.services.find(
        (entry) => entry.clientId === identity.clientId,
      );
      return grant
        ? { id: grant.id, subject: grant.subject, scopes: grant.scopes }
        : undefined;
    },
  });
  const driver = configuredDriver(config, configuration);
  host = await serve(
    driver,
    await configuredServer(config, configuration, undefined, authentication),
  );
  process.stdout.write(
    JSON.stringify({
      type: "listening",
      transport: "loopback",
      authentication: "better-auth",
    }) + "\n",
  );
  await new Promise((done, reject) => {
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      void host.close().then(done, reject);
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
} catch {
  // Neither configuration nor auth/provider exception payloads belong in container logs.
  process.stderr.write(
    "AgenticDriver deployment failed. Check its configuration, secret references and application auth service.\n",
  );
  await host?.close();
  process.exitCode = 1;
}
