import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const version = "v24.21.0";
const archive = `node-${version}-linux-x64.tar.xz`;
// First-party Node release, pinned to its published SHA256. Linux x64 is the initial qualified build.
const sha256 =
  "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6";
if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("This preview packages Linux x64 only.");
const runtime = join(root, "runtime");
await mkdir(runtime, { recursive: true });
const marker = join(runtime, "version.json");
let prepared = false;
try {
  const receipt = JSON.parse(await readFile(marker, "utf8"));
  const binaryHash = createHash("sha256")
    .update(await readFile(join(runtime, "node")))
    .digest("hex");
  prepared =
    receipt.version === version &&
    receipt.archiveSha256 === sha256 &&
    receipt.binarySha256 === binaryHash;
} catch {}
if (!prepared) {
  const response = await fetch(
    `https://nodejs.org/dist/${version}/${archive}`,
    { redirect: "error" },
  );
  if (!response.ok)
    throw new Error("Could not download the pinned Node runtime.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== sha256)
    throw new Error("Node runtime checksum mismatch.");
  const path = join(runtime, archive);
  await writeFile(path, bytes);
  const unpacked = join(runtime, `node-${version}-linux-x64`);
  try {
    execFileSync("tar", [
      "-xJf",
      path,
      "-C",
      runtime,
      `node-${version}-linux-x64/bin/node`,
      `node-${version}-linux-x64/LICENSE`,
    ]);
    await cp(join(unpacked, "bin/node"), join(runtime, "node"));
    await cp(join(unpacked, "LICENSE"), join(runtime, "NODE-LICENSE"));
    await writeFile(
      marker,
      JSON.stringify({
        version,
        archiveSha256: sha256,
        binarySha256: createHash("sha256")
          .update(await readFile(join(runtime, "node")))
          .digest("hex"),
      }) + "\n",
    );
  } finally {
    await rm(path, { force: true });
    await rm(unpacked, { recursive: true, force: true });
  }
}
const panel = fileURLToPath(import.meta.resolve("@agenticdriver/sdk/ui"));
await cp(panel, join(root, "renderer/provider-panel.js"));
console.log(`Prepared ${version} and the current SDK provider component.`);
