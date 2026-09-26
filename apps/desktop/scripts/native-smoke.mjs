import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root = fileURLToPath(new URL("../", import.meta.url));
const profile = await mkdtemp(join(tmpdir(), "agenticdriver-native-smoke-"));
const executable =
  process.argv[2] || join(root, "node_modules/electron/dist/electron");
const args = process.argv[2] ? ["--smoke-test"] : [root, "--smoke-test"];
if (process.env.AGENTICDRIVER_DESKTOP_HEADLESS === "1")
  args.push("--ozone-platform=x11");
const child = spawn(executable, args, {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    NODE_OPTIONS: undefined,
    AGENTICDRIVER_DESKTOP_DATA: profile,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "",
  stderr = "";
child.stdout.on("data", (data) => {
  stdout = (stdout + data).slice(-16384);
});
child.stderr.on("data", (data) => {
  stderr = (stderr + data).slice(-16384);
});
// Test harness watchdog only: no inference or production run timeout.
let forceKill;
const watchdog = setTimeout(() => {
  child.kill();
  forceKill = setTimeout(() => child.kill("SIGKILL"), 3000);
}, 90000);
try {
  const [code] = await once(child, "exit");
  const evidence = stdout
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    })
    .find((value) => value.desktopSmoke);
  if (code !== 0 || evidence?.desktopSmoke !== "passed") {
    process.stderr.write(stderr);
    if (evidence) console.error(JSON.stringify(evidence));
    throw new Error("Native desktop smoke did not pass.");
  }
  assert.equal(evidence.rendererIsolated, true);
  assert.equal(evidence.providerSetupUi, true);
  assert.equal(evidence.providerRemovalUi, true);
  assert.equal(evidence.strictStyleCsp, true);
  console.log(
    JSON.stringify({
      ...evidence,
      executable: process.argv[2] ? "packaged" : "development",
      nodeOptionsDisabled: true,
    }),
  );
} finally {
  clearTimeout(watchdog);
  clearTimeout(forceKill);
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await rm(profile, { recursive: true, force: true });
}
