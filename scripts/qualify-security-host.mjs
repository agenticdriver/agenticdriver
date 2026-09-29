// Separate real-account host; it never inherits another application's grants.
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
import { serve } from "@agenticdriver/sdk/server";

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    state: { type: "string" },
    provision: { type: "boolean", default: false },
  },
});
if (!values.config || !values.state)
  throw new Error("Provide independent --config and --state paths.");
process.umask(0o077);
const state = resolve(values.state),
  configPath = resolve(values.config);
await mkdir(state, { recursive: true, mode: 0o700 });
const config = await readHostConfig(configPath);
if (
  config.tokens.length ||
  config.jobs ||
  config.listen.host !== "127.0.0.1" ||
  config.providers.length !== 1 ||
  config.providers[0].kind !== "codex" ||
  config.providers[0].applicationTools !== "mcp"
)
  throw new Error(
    "Use a separate loopback Codex MCP host without static tokens or detached jobs.",
  );
const provider = config.providers[0].id;
const connections = await hostConnections(join(state, "connections.json"), {
  providers: () => [provider],
});
if (values.provision) {
  const base = {
    subject: "rc-tool-owner",
    providers: [provider],
    tools: ["read_release_note"],
    applicationTools: [{ name: "read_release_note" }],
    approveTools: ["read_release_note"],
  };
  for (const [name, grant] of Object.entries({
    owner: base,
    foreign: { ...base, subject: "rc-other-tenant" },
    restricted: { subject: base.subject, providers: [provider] },
    administrator: {
      subject: "rc-operator",
      providers: [],
      manageProviders: true,
    },
  })) {
    const invite = await connections.create({
      grant,
      expiresInSeconds: 600,
      connectionLifetimeSeconds: 21_600,
    });
    await writeFile(
      join(state, `${name}.invitation`),
      connectionInvitation(config.clientUrl, invite.code),
      { flag: "wx", mode: 0o600 },
    );
  }
  console.log("Created four private, separately scoped one-use invitations.");
} else {
  const driver = configuredDriver(config, configPath, {
    onApprovalAudit: (record) => {
      // Private actual decisions and rejected attempts; never publish raw arguments.
      appendFileSync(
        join(state, "approvals.jsonl"),
        JSON.stringify(record) + "\n",
        { mode: 0o600 },
      );
    },
  });
  const host = await serve(driver, {
    ...(await configuredServer(config, configPath, undefined, {
      authenticate: (token) => connections.authenticate(token),
    })),
    connections,
  });
  await appendFile(
    join(state, "lifecycle.jsonl"),
    JSON.stringify({ startedAt: new Date().toISOString(), url: host.url }) +
      "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ url: host.url }));
  process.once("SIGINT", () => void host.close());
  process.once("SIGTERM", () => void host.close());
}
