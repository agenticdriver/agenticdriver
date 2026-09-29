// A separate, explicitly provisioned real-account host for retrieval qualification.
// Canonical document permissions are supplied by the operator, never a model.
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import {
  configuredDriver,
  configuredServer,
  readHostConfig,
} from "@agenticdriver/sdk/host";
import {
  hostConnections,
  connectionInvitation,
} from "@agenticdriver/sdk/connections";
import {
  LocalEmbeddingAdapter,
  RetrievalService,
  SqliteVectorStore,
} from "@agenticdriver/sdk/retrieval";
import { serve } from "@agenticdriver/sdk/server";

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    state: { type: "string" },
    cache: { type: "string" },
    sources: { type: "string" },
    invite: { type: "string" },
    "grant-file": { type: "string" },
    "invite-file": { type: "string" },
  },
});
process.umask(0o077);
for (const name of ["config", "state"])
  if (!values[name]) throw new Error(`Provide --${name}.`);
const configPath = resolve(values.config),
  state = resolve(values.state);
const config = await readHostConfig(configPath);
if (config.tokens.length || config.jobs || config.listen.host !== "127.0.0.1")
  throw new Error(
    "Use a separate loopback host with a new connection store and no detached jobs or static credentials.",
  );
await mkdir(state, { recursive: true, mode: 0o700 });
const connections = await hostConnections(join(state, "connections.json"), {
  providers: () => config.providers.map((provider) => provider.id),
});
if (values.invite) {
  if (!values["grant-file"] || !values["invite-file"])
    throw new Error(
      "Provide the reviewed grant file and a new private invitation file.",
    );
  const grant = JSON.parse(await readFile(values["grant-file"], "utf8"));
  const invitation = await connections.create({
    grant,
    expiresInSeconds: 600,
    connectionLifetimeSeconds: 21_600,
  });
  await writeFile(
    values["invite-file"],
    connectionInvitation(values.invite, invitation.code),
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      invitationId: invitation.id,
      expiresAt: invitation.expiresAt,
    }),
  );
} else {
  for (const name of ["cache", "sources"])
    if (!values[name]) throw new Error(`Provide --${name}.`);
  const embedding = new LocalEmbeddingAdapter({
    providerId: "local-cpu",
    accountId: "rc-local-embeddings",
    model: "Xenova/all-MiniLM-L6-v2",
    revision: "751bff37182d3f1213fa05d7196b954e230abad9",
    dimensions: 384,
    cacheDirectory: resolve(values.cache),
  });
  const store = await SqliteVectorStore.open(join(state, "vectors.sqlite"));
  const retrieval = new RetrievalService(
    [
      {
        id: "release-library",
        version: "minilm-q8-v1",
        embedding,
        store,
        // This qualification policy is a trusted private operator file. Applications
        // use their own authoritative document/tenant permission resolver instead.
        authorize: async ({ operation }, context) => {
          const policy = JSON.parse(await readFile(values.sources, "utf8"));
          const grant = Object.hasOwn(policy, context.subject)
            ? policy[context.subject]
            : null;
          if (!grant?.operations?.includes(operation)) return null;
          return { namespace: grant.namespace, sources: grant.sources };
        },
      },
    ],
    {
      usage: {
        hostId: config.usage.hostId,
        onUsage: (record) =>
          appendFile(
            join(state, "embedding-usage.jsonl"),
            JSON.stringify(record) + "\n",
            { mode: 0o600 },
          ),
        onTelemetryError: () =>
          process.stderr.write(
            "Embedding receipt write failed; reconcile before repeating work.\n",
          ),
      },
    },
  );
  const driver = configuredDriver(config, configPath, { retrieval });
  const host = await serve(driver, {
    ...(await configuredServer(config, configPath, undefined, {
      authenticate: (token) => connections.authenticate(token),
    })),
    connections,
  });
  console.log(JSON.stringify({ url: host.url, embedding: embedding.info }));
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await host.close();
    await store.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
