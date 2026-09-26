import { chmod, lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
/** Normalize the public artifact only. Never change private runtime/profile permissions. */
export default async function afterPack({ appOutDir }) {
  const metadata = JSON.parse(
    await readFile(join(appOutDir, "resources", "app", "package.json"), "utf8"),
  );
  if (metadata.name !== "@agenticdriver/desktop")
    throw new Error(
      "Refusing to change permissions outside a built desktop artifact.",
    );
  async function visit(path) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      await chmod(path, 0o755);
      for (const name of await readdir(path)) await visit(join(path, name));
    } else if (info.isFile())
      await chmod(path, info.mode & 0o111 ? 0o755 : 0o644);
  }
  await visit(appOutDir);
}
