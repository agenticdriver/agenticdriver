/** One provider account per Linux container. This is not application login. */
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  configuredDriver,
  configuredServer,
  readHostConfig,
} from "../../dist/host.js";
import { serve } from "../../dist/server.js";

const accountPaths = {
  codex: { directory: "/home/node/.codex", binary: "/usr/local/bin/codex" },
  "claude-code": {
    directory: "/home/node/.claude",
    binary: "/usr/local/bin/claude",
  },
};

/** Recipe restrictions supplement, rather than replace, HostConfig validation. */
export function validateAccountDeployment(config) {
  if (
    config.providers.length !== 1 ||
    !config.usage?.hostId ||
    !config.providers[0].accountId ||
    !config.tokens.length ||
    config.listen.host !== "127.0.0.1" ||
    config.listen.port !== 7433 ||
    config.tls ||
    config.jobs
  )
    throw new Error(
      "Use a single-account loopback deployment with scoped driver tokens.",
    );
  const provider = config.providers[0];
  const paths = accountPaths[provider.kind];
  if (!paths)
    throw new Error(
      "This recipe supports one Codex or Claude Code account host.",
    );
  if (
    paths &&
    (provider.accountDirectory !== paths.directory ||
      provider.binary !== paths.binary)
  )
    throw new Error(
      "Use the dedicated account home and the image-installed native executable.",
    );
  if (
    config.tokens.some(
      (token) =>
        token.manageProviders ||
        token.providers.length !== 1 ||
        token.providers.some((id) => id !== provider.id) ||
        !token.tokenRef.file ||
        !/^\/run\/secrets\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(
          token.tokenRef.file,
        ),
    )
  )
    throw new Error(
      "Use private mounted driver credentials scoped to this provider only.",
    );
  if (
    (config.operations &&
      config.operations.directory !== "/var/lib/agenticdriver/operations") ||
    (config.usageLog &&
      config.usageLog !== "/var/lib/agenticdriver/usage.jsonl")
  )
    throw new Error(
      "Keep writable execution state in the dedicated account volume.",
    );
  return config;
}

async function main() {
  process.umask(0o077);
  let host;
  try {
    if (process.platform !== "linux" || process.getuid?.() !== 1000)
      throw new Error("Use the non-root Linux account image.");
    const configuration = "/etc/agenticdriver/config.json";
    const config = validateAccountDeployment(
      await readHostConfig(configuration),
    );
    const provider = config.providers[0];
    await access(provider.binary, constants.X_OK);
    host = await serve(
      configuredDriver(config, configuration),
      await configuredServer(config, configuration),
    );
    process.stdout.write(
      '{"type":"listening","transport":"loopback","scope":"single-account"}\n',
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
    // Never print configuration, native auth state or credentials.
    process.stderr.write(
      "AgenticDriver account host failed. Check the one-account configuration, mounted private credentials and selected image.\n",
    );
    await host?.close();
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
