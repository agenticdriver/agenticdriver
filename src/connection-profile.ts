import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { AgenticClient } from "./client.js";
import {
  connectionTarget,
  type ConnectionCredentials,
} from "./connection-types.js";
import { DriverError } from "./errors.js";
import { secureBaseUrl } from "./security.js";
import { secretResolver, singleLineSecret } from "./secrets.js";

const ProfileSchema = z
  .object({
    version: z.literal(1),
    url: z.string(),
    id: z.uuid(),
    expiresAt: z.iso.datetime({ offset: true }),
    tokenFile: z.string().regex(/^connection-[a-f0-9-]+\.token$/),
  })
  .strict();
export type ConnectionProfile = z.infer<typeof ProfileSchema>;

/** Server-only validated metadata. Does not load the bearer token or check host availability. */
export async function readConnectionProfile(
  profilePath: string,
): Promise<ConnectionProfile> {
  const path = resolve(profilePath);
  const secrets = secretResolver(dirname(path));
  let profile: ConnectionProfile;
  try {
    profile = ProfileSchema.parse(JSON.parse(await secrets({ file: path })));
  } catch {
    throw new DriverError(
      "CONNECTION_REQUIRED",
      "Choose a private connection profile created by agenticdriver connect.",
    );
  }
  secureBaseUrl(profile.url);
  return profile;
}

export async function connectedClient(
  profilePath: string,
): Promise<AgenticClient> {
  const path = resolve(profilePath),
    secrets = secretResolver(dirname(path));
  const profile = await readConnectionProfile(path);
  secureBaseUrl(profile.url);
  if (Date.parse(profile.expiresAt) <= Date.now())
    throw new DriverError(
      "CONNECTION_EXPIRED",
      "This connection expired. Pair this application again.",
    );
  return new AgenticClient({
    url: profile.url,
    token: () => singleLineSecret(secrets, { file: profile.tokenFile }, 32),
  });
}

/** Creates a fresh private profile; never replaces an existing connection or repeats an uncertain exchange. */
export async function connectClient(
  invitation: string,
  profilePath: string,
): Promise<ConnectionProfile> {
  const path = resolve(profilePath),
    directory = dirname(path);
  const target = connectionTarget(invitation);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Fail before consuming an invitation if this profile already exists.
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    await file.close();
    throw new DriverError(
      "CONNECTION_EXISTS",
      "Choose a new connection profile path.",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const credentials: ConnectionCredentials = await new AgenticClient({
    url: target.url,
    token: target.code,
  }).exchangeConnection();
  const tokenFile = `connection-${randomUUID()}.token`,
    credentialPath = join(directory, tokenFile);
  const temporary = join(directory, `.${basename(path)}-${randomUUID()}.tmp`);
  let published = false;
  try {
    const profile: ConnectionProfile = {
      version: 1,
      url: target.url,
      id: credentials.id,
      expiresAt: credentials.expiresAt,
      tokenFile,
    };
    await writeFile(credentialPath, credentials.token + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(temporary, JSON.stringify(profile, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    await link(temporary, path);
    published = true;
    return profile;
  } catch {
    throw new DriverError(
      "CONNECTION_SAVE_FAILED",
      "The invitation was consumed but the private connection profile could not be saved. Revoke the new connection on the host before pairing again.",
      false,
      "uncertain",
    );
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
    if (!published) await rm(credentialPath, { force: true }).catch(() => {});
  }
}
