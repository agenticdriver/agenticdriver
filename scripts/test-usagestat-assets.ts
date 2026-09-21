/** Native metadata and existing artwork, with all provider probes disabled in an isolated profile. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { UsageStatClient } from "../src/usagestat.js";
import { createProviderAssetCache } from "../src/provider-assets.js";
import { providerPresentation } from "../src/catalog.js";
const [binary, plugins] = process.argv.slice(2);
if (!binary || !plugins)
  throw new Error(
    "Usage: tsx scripts/test-usagestat-assets.ts /absolute/usagestatd /absolute/usagestat/plugins",
  );
const work = await mkdtemp(join(tmpdir(), "sdk-native-icons-"));
let daemon: ChildProcess | undefined;
try {
  const root = join(work, "plugins");
  await mkdir(root);
  const ids = ["codex", "claude", "gemini"];
  // Isolate executable resource lookup as well as config/data/current directory.
  const executable = join(
    work,
    process.platform === "win32" ? "usagestatd.exe" : "usagestatd",
  );
  await cp(resolve(binary), executable);
  for (const id of ids)
    await cp(join(resolve(plugins), id), join(root, id), { recursive: true });
  await cp(
    join(resolve(plugins), "UPSTREAM-LICENSES.md"),
    join(root, "UPSTREAM-LICENSES.md"),
  );
  const config = join(work, "config.toml");
  await writeFile(
    config,
    ids
      .map((id) => `[[providers]]\nid = "${id}"\nenabled = false\n`)
      .join("\n"),
  );
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    socket.close((e) => (e ? reject(e) : resolve())),
  );
  daemon = spawn(
    executable,
    ["--config", config, "--bind", `127.0.0.1:${port}`, "--plugin-dir", root],
    {
      cwd: work,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        USAGESTAT_CONFIG_DIR: join(work, "config"),
        USAGESTAT_DATA_DIR: join(work, "data"),
      },
      stdio: "ignore",
    },
  );
  let failed: Error | undefined;
  daemon.on("error", (e) => {
    failed = e;
  });
  const client = new UsageStatClient({ url: `http://127.0.0.1:${port}` });
  let providers: Awaited<ReturnType<UsageStatClient["providers"]>> = [];
  for (let n = 0; n < 100; n++) {
    if (failed || daemon.exitCode !== null)
      throw new Error("Isolated Usagestat catalog host did not start");
    try {
      providers = await client.providers();
      if (providers.length === 3) break;
    } catch {}
    await delay(50);
  }
  assert.deepEqual(providers.map((p) => p.id).sort(), [...ids].sort());
  assert.ok(providers.every((p) => p.enabled === false));
  assert.deepEqual(await client.usage(), [], "No provider probe may run");
  const cache = await createProviderAssetCache({
    providers,
    root,
    allowlist: ids.flatMap((providerId) =>
      (["monochrome", "color"] as const).map((variant) => ({
        providerId,
        variant,
        license: {
          id: "MIT",
          attribution:
            "Usagestat upstream notices; provider marks belong to their owners.",
          noticePath: "UPSTREAM-LICENSES.md",
        },
      })),
    ),
  });
  assert.ok(cache.manifest.length >= 3);
  const notices = await readFile(join(root, "UPSTREAM-LICENSES.md"));
  for (const metadata of providers) {
    const card = providerPresentation(
      {
        id: `${metadata.id}-personal`,
        name: metadata.name!,
        vendor: metadata.id,
        authMode: "cli-session",
        usageStatId: metadata.id,
        capabilities: { tools: false, textStreaming: true },
      },
      {
        metadata,
        assets: cache.manifest,
        account: { id: "fixture-account", label: "Personal" },
      },
    );
    assert.equal(card.icon.kind, "asset");
    assert.ok(!JSON.stringify(card).includes(root));
  }
  for (const asset of cache.manifest) {
    const source = join(
      root,
      asset.providerId,
      asset.variant === "color" ? "icon-color.svg" : "icon.svg",
    );
    const served = cache.respond(
      new Request("https://app.example" + asset.src),
    )!;
    assert.deepEqual(
      Buffer.from(await served.arrayBuffer()),
      await readFile(source),
    );
    const notice = cache.respond(
      new Request("https://app.example" + asset.license.noticeUrl),
    )!;
    assert.deepEqual(Buffer.from(await notice.arrayBuffer()), notices);
  }
  console.log(
    JSON.stringify({
      nativeCatalog: "passed",
      providers: ids,
      assetVariants: cache.manifest.length,
      missingVariants: cache.missing,
      notices: "byte-identical",
      providerProbes: 0,
    }),
  );
} finally {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    const stopped = once(daemon, "exit");
    daemon.kill();
    const cleanup = setTimeout(() => daemon?.kill("SIGKILL"), 5000);
    cleanup.unref();
    try {
      await stopped;
    } finally {
      clearTimeout(cleanup);
    }
  }
  await rm(work, { recursive: true, force: true });
}
