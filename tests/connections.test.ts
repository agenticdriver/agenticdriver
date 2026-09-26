import assert from "node:assert/strict";
import test from "node:test";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgenticClient,
  connectionInvitation,
  connectionTarget,
} from "../src/client.js";
import {
  connectedClient,
  connectClient,
  hostConnections,
  readConnectionProfile,
  withConnections,
} from "../src/connections.js";
import { AgenticDriver } from "../src/driver.js";
import { mockProvider } from "../src/providers/mock.js";
import { serve } from "../src/server.js";
import { CliProcess } from "./cli-helpers.js";

const admin = "operator-fixture-credential-at-least-32-characters";
test("public profile metadata reader validates private files without loading credentials or contacting a host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "driver-profile-metadata-"));
  const path = join(directory, "connection.json");
  const profile = {
    version: 1,
    url: "http://127.0.0.1:7432/",
    id: "77262ad0-3571-4bd0-9933-9245d7e85d5c",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    tokenFile: "connection-a87cbef0-46f9-4c6f-945b-4d9fa6795637.token",
  };
  try {
    // The credential is deliberately absent and the metadata is expired.
    // Settings can display it without claiming an authenticated connection.
    await writeFile(path, JSON.stringify(profile), { mode: 0o600 });
    assert.deepEqual(await readConnectionProfile(path), profile);
    await assert.rejects(connectedClient(path), { code: "CONNECTION_EXPIRED" });
    await writeFile(
      path,
      JSON.stringify({ ...profile, url: "http://remote.example" }),
    );
    await assert.rejects(readConnectionProfile(path), {
      code: "INSECURE_TRANSPORT",
    });
    await writeFile(
      path,
      JSON.stringify({ ...profile, tokenFile: "../credential" }),
    );
    await assert.rejects(readConnectionProfile(path), {
      code: "CONNECTION_REQUIRED",
    });
    if (process.platform !== "win32") {
      await writeFile(path, JSON.stringify(profile));
      await chmod(path, 0o644);
      await assert.rejects(readConnectionProfile(path), {
        code: "CONNECTION_REQUIRED",
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("one-use invitations persist across restart, preserve scope, expire and revoke without changing static credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "driver-pairing-"));
  let now = Date.now();
  const path = join(directory, "connections.json");
  const options = { providers: () => ["mock"], now: () => now };
  try {
    let store = await hostConnections(path, options);
    const invite = await store.create({
      grant: { subject: "application", providers: ["mock"] },
      expiresInSeconds: 30,
      connectionLifetimeSeconds: 60,
    });
    assert.ok(!(await readFile(path, "utf8")).includes(invite.code));
    store = await hostConnections(path, options);
    const exchanged = await Promise.allSettled([
      store.exchange(invite.code),
      store.exchange(invite.code),
    ]);
    assert.equal(exchanged.filter((r) => r.status === "fulfilled").length, 1);
    const grant = exchanged.find((r) => r.status === "fulfilled")!;
    assert.equal(grant.status, "fulfilled");
    const credential = (
      grant as PromiseFulfilledResult<
        Awaited<ReturnType<typeof store.exchange>>
      >
    ).value;
    assert.ok(!(await readFile(path, "utf8")).includes(credential.token));
    assert.equal(
      (await store.authenticate(credential.token))!.manageProviders,
      undefined,
    );
    assert.deepEqual((await store.authenticate(credential.token))!.providers, [
      "mock",
    ]);
    assert.equal(await store.authenticate("unrelated-token"), undefined);
    assert.equal((await store.list()).invitations.length, 0);
    assert.ok(!JSON.stringify(await store.list()).includes(credential.token));
    now += 60_001;
    assert.equal(await store.authenticate(credential.token), undefined);
    const second = await store.create({
      grant: { subject: "operator", providers: [], manageProviders: true },
    });
    const secondCredential = await store.exchange(second.code);
    assert.equal(
      (await store.authenticate(secondCredential.token))!.manageProviders,
      true,
    );
    await store.revoke({ id: secondCredential.id });
    assert.equal(
      await (
        await hostConnections(path, options)
      ).authenticate(secondCredential.token),
      undefined,
    );
    const expired = await store.create({
      grant: { subject: "app", providers: [] },
      expiresInSeconds: 30,
    });
    now += 30_001;
    await assert.rejects(store.exchange(expired.code), {
      code: "INVITATION_REJECTED",
    });
    if (process.platform !== "win32")
      assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pairing transport rejects unprivileged grants and unsafe targets; connected profiles keep bearer credentials private", async () => {
  const directory = await mkdtemp(join(tmpdir(), "driver-connection-http-"));
  const store = await hostConnections(join(directory, "state.json"), {
    providers: () => ["mock"],
  });
  const server = await serve(
    new AgenticDriver({ providers: [mockProvider()] }),
    withConnections(
      {
        port: 0,
        tokens: [
          {
            token: admin,
            subject: "operator",
            providers: [],
            manageProviders: true,
          },
        ],
      },
      store,
    ),
  );
  try {
    const operator = new AgenticClient({ url: server.url, token: admin });
    const invite = await operator.createInvitation({
      grant: { subject: "selected-app", providers: ["mock"] },
    });
    const text = connectionInvitation(server.url, invite.code);
    assert.deepEqual(connectionTarget(text), {
      url: server.url + "/",
      code: invite.code,
    });
    const profilePath = join(directory, "app", "connection.json");
    const profile = await connectClient(text, profilePath);
    const app = await connectedClient(profilePath);
    assert.equal(
      (await app.run({ provider: "mock", model: "demo", input: "Synthetic" }))
        .text,
      "AgenticDriver is connected.",
    );
    await assert.rejects(
      app.createInvitation({
        grant: {
          subject: "elevated",
          providers: ["mock"],
          manageProviders: true,
        },
      }),
      { code: "FORBIDDEN" },
    );
    await assert.rejects(app.connections(), { code: "FORBIDDEN" });
    await assert.rejects(connectClient(text, join(directory, "replay.json")), {
      code: "INVITATION_REJECTED",
    });
    await assert.rejects(connectClient(text, profilePath), {
      code: "CONNECTION_EXISTS",
    });
    const raw = await readFile(profilePath, "utf8");
    assert.ok(!raw.includes(invite.code));
    const token = (
      await readFile(join(directory, "app", profile.tokenFile), "utf8")
    ).trim();
    assert.ok(!raw.includes(token));
    assert.equal((await operator.connections()).connections[0]!.id, profile.id);
    assert.equal((await operator.revokeConnection(profile.id)).revoked, true);
    await assert.rejects(app.providers(), { code: "UNAUTHORIZED" });
    assert.equal((await operator.connections()).connections.length, 0);
    await assert.rejects(
      operator.createInvitation({
        grant: { subject: "x", providers: ["unknown"] },
      }),
      { code: "INVALID_INVITATION" },
    );
    for (const url of [
      "http://remote.example",
      "https://user:pass@remote.example",
      "https://remote.example?secret=1",
    ])
      assert.throws(() => connectionInvitation(url, invite.code), {
        code: "INSECURE_TRANSPORT",
      });
    assert.throws(() => connectionTarget("ad1.invalid.secret"), {
      code: "INVALID_INVITATION",
    });
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI setup, pair and connect provision a usable local connection without model inference", async () => {
  const directory = await mkdtemp(join(tmpdir(), "driver-setup-"));
  const path = join(directory, "host.json");
  const entry = [
    "--import",
    "tsx",
    fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
  ];
  const process = new CliProcess(entry, [
    "setup",
    "--config",
    path,
    "--provider",
    "mock",
    "--port",
    "0",
    "--manage",
    "--json",
  ]);
  try {
    const invitation = await process.waitFor((output) =>
      output
        .split("\n")
        .slice(0, -1)
        .map(
          (line) =>
            JSON.parse(line) as {
              event?: string;
              invitation: string;
              grant: { manageProviders?: boolean };
            },
        )
        .find((value) => value.event === "invitation"),
    );
    assert.equal(invitation.grant.manageProviders, true);
    const file = join(directory, "invitation.txt");
    await writeFile(file, invitation.invitation, { mode: 0o600 });
    const profile = join(directory, "app", "connection.json");
    const connected = await new CliProcess(entry, [
      "connect",
      "--invite-file",
      file,
      "--connection",
      profile,
      "--json",
    ]).finished;
    assert.equal(connected.code, 0, connected.stderr);
    assert.ok(
      !connected.stdout.includes(connectionTarget(invitation.invitation).code),
    );
    const client = await connectedClient(profile);
    assert.equal((await client.management()).providers[0]!.kind, "mock");
  } finally {
    await process.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
