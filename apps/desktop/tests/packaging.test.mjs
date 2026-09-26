import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, stat, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import afterPack from "../scripts/after-pack.mjs";
test("public distribution permissions work across users without changing private state or following symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-packaging-"));
  const output = join(root, "artifact"),
    resource = join(output, "resources/app");
  try {
    await mkdir(resource, { recursive: true, mode: 0o700 });
    await writeFile(
      join(resource, "package.json"),
      JSON.stringify({ name: "@agenticdriver/desktop" }),
      { mode: 0o600 },
    );
    await writeFile(
      join(output, "agenticdriver-desktop"),
      "fixture executable",
      { mode: 0o700 },
    );
    await writeFile(join(root, "private.token"), "synthetic token", {
      mode: 0o600,
    });
    await symlink(join(root, "private.token"), join(resource, "outside-link"));
    await afterPack({ appOutDir: output });
    assert.equal((await stat(resource)).mode & 0o777, 0o755);
    assert.equal(
      (await stat(join(resource, "package.json"))).mode & 0o777,
      0o644,
    );
    assert.equal(
      (await stat(join(output, "agenticdriver-desktop"))).mode & 0o777,
      0o755,
    );
    assert.equal((await stat(join(root, "private.token"))).mode & 0o777, 0o600);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
