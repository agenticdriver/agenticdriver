/** Run against the installed backend in an isolated profile, without polling provider accounts. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { desktopController } from "../src/controller.mjs";
const binary = process.argv[2];
if (!binary)
  throw new Error("Supply the existing native usagestatd binary path.");
const root = await mkdtemp(join(tmpdir(), "desktop-usagestat-"));
const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const daemon = spawn(
  resolve(binary),
  ["--no-poll", "--bind", `127.0.0.1:${port}`],
  {
    env: {
      PATH: process.env.PATH,
      USAGESTAT_CONFIG_DIR: join(root, "usage-config"),
      USAGESTAT_DATA_DIR: join(root, "usage-data"),
    },
    stdio: "ignore",
  },
);
let controller;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (daemon.exitCode !== null)
      throw new Error("Isolated Usagestat process exited.");
    try {
      ready = (
        await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(300),
        })
      ).ok;
      if (ready) break;
    } catch {}
    await delay(50);
  }
  assert.equal(ready, true);
  controller = await desktopController(join(root, "desktop"), {
    autoStart: false,
  });
  await controller.request({
    action: "usage-settings",
    url: `http://127.0.0.1:${port}`,
  });
  const result = await controller.request({ action: "usage" });
  assert.deepEqual(result.sections, {
    providers: "available",
    usage: "available",
  });
  assert.equal(result.available, true);
  assert.deepEqual(result.snapshots, []);
  console.log(
    JSON.stringify({
      nativeUsagestatReadContract: "passed",
      polling: false,
      providerCalls: 0,
      sections: result.sections,
    }),
  );
} finally {
  await controller?.close();
  if (daemon.exitCode === null && daemon.signalCode === null) {
    const exit = once(daemon, "exit");
    daemon.kill();
    await exit;
  }
  await rm(root, { recursive: true, force: true });
}
