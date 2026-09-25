import { hostConnections } from "./connections.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DriverError } from "./errors.js";
import {
  configuredDriver,
  configuredProviders,
  readHostConfig,
  validateHostConfig,
  type ConfiguredDriverOptions,
  type HostConfig,
} from "./host.js";
import {
  ConfigureProviderSchema,
  type ManagementSnapshot,
  type ProviderManagement,
} from "./management-types.js";
export type * from "./management-types.js";

const kinds = [
  "codex",
  "claude-code",
  "gemini-cli",
  "openai",
  "anthropic",
  "gemini",
  "xai",
  "xai-responses",
  "openai-compatible",
  "mock",
];
const revision = (config: HostConfig) =>
  createHash("sha256").update(JSON.stringify(config)).digest("hex");
const accounts = (config: HostConfig) =>
  Object.fromEntries(
    config.providers.flatMap((p) => (p.accountId ? [[p.id, p.accountId]] : [])),
  );

/** Owns provider settings only; application identity and user authentication remain application-owned. */
export async function managedHost(
  configPath: string,
  options: ConfiguredDriverOptions = {},
) {
  const path = resolve(configPath),
    directory = dirname(path);
  let config = await readHostConfig(path);
  const driver = configuredDriver(config, path, options);
  let queue: Promise<unknown> = Promise.resolve();
  const snapshot = (): ManagementSnapshot => ({
    version: 1,
    revision: revision(config),
    providers: structuredClone(config.providers),
    supportedKinds: [...kinds],
  });
  const configure: ProviderManagement["configure"] = (input) => {
    const operation = queue.then(async () => {
      const parsed = ConfigureProviderSchema.safeParse(input);
      if (!parsed.success)
        throw new DriverError(
          "INVALID_CONFIG",
          "Provider settings do not match the management schema.",
        );
      const change = parsed.data;
      let lock;
      const lockPath = path + ".management-lock";
      try {
        lock = await open(lockPath, "wx", 0o600);
      } catch {
        throw new DriverError(
          "CONFIG_BUSY",
          "Another settings writer holds the host configuration lock.",
          true,
        );
      }
      const temporary = join(directory, `.provider-config-${randomUUID()}.tmp`);
      let credential: string | undefined,
        committed = false;
      try {
        const disk = await readHostConfig(path);
        if (
          change.revision !== revision(config) ||
          revision(disk) !== revision(config)
        )
          throw new DriverError(
            "CONFIG_CONFLICT",
            "Settings changed. Reload the host configuration before saving.",
          );
        const previous = config.providers.find(
          (p) => p.id === change.provider.id,
        );
        if (
          previous &&
          (previous.kind !== change.provider.kind ||
            previous.accountId !== change.provider.accountId)
        )
          throw new DriverError(
            "PROVIDER_IDENTITY_CHANGED",
            "Use a new instance ID for a different provider kind or account.",
          );
        if (change.provider.kind === "extension")
          throw new DriverError(
            "UNSUPPORTED_CONFIGURATION",
            "Extension settings are installed by the host operator.",
          );
        const provider = structuredClone(change.provider);
        if (change.apiKey !== undefined) {
          if (!("apiKeyRef" in provider))
            throw new DriverError(
              "INVALID_CONFIG",
              "API keys apply only to API provider connections.",
            );
          await mkdir(join(directory, "credentials"), {
            recursive: true,
            mode: 0o700,
          });
          credential = join(
            directory,
            "credentials",
            `provider-${randomUUID()}.key`,
          );
          await writeFile(credential, change.apiKey + "\n", {
            flag: "wx",
            mode: 0o600,
          });
          provider.apiKeyRef = { file: credential };
        }
        const next = validateHostConfig({
          ...config,
          providers: previous
            ? config.providers.map((p) => (p.id === provider.id ? provider : p))
            : [...config.providers, provider],
        });
        const adapters = configuredProviders(next, path, options);
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(JSON.stringify(next, null, 2) + "\n");
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, path);
        committed = true;
        // No await between publication and activation. Existing runs own the previous adapter.
        driver.configureProviders(adapters, accounts(next));
        config = next;
        return snapshot();
      } catch (error) {
        if (error instanceof DriverError) throw error;
        throw new DriverError(
          "CONFIG_WRITE_FAILED",
          "Provider settings could not be saved. Refresh before retrying.",
        );
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
        if (credential && !committed)
          await rm(credential, { force: true }).catch(() => {});
        await lock.close();
        await rm(lockPath, { force: true });
      }
    });
    queue = operation.catch(() => {});
    return operation;
  };
  const connections = await hostConnections(
    join(directory, "state", "connections.json"),
    { providers: () => driver.listProviders().map((p) => p.id) },
  );
  return {
    driver,
    connections,
    management: { snapshot, configure } satisfies ProviderManagement,
    config: () => structuredClone(config),
  };
}
