/** Install a tested unpacked Linux preview and a user-local application launcher. No sudo or service changes. */
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
const source = resolve(process.argv[2] ?? "release/linux-unpacked");
if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("This installer supports the qualified Linux x64 preview.");
const app = join(source, "resources", "app");
const pkg = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
if (pkg.name !== "@agenticdriver/desktop")
  throw new Error("Choose the built AgenticDriver desktop directory.");
const digest = createHash("sha256");
async function hashTree(directory, relative = "") {
  const entries = (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const path = join(directory, entry.name),
      name = relative + "/" + entry.name;
    digest.update(name + "\0");
    if (entry.isDirectory()) await hashTree(path, name);
    else if (entry.isSymbolicLink()) digest.update(await readlink(path));
    else digest.update(await readFile(path));
  }
}
await hashTree(app);
const version = `${pkg.version}-${digest.digest("hex").slice(0, 12)}`;
const data = process.env.XDG_DATA_HOME
  ? resolve(process.env.XDG_DATA_HOME)
  : join(homedir(), ".local", "share");
const base = join(data, "agenticdriver", "desktop");
const target = join(base, "runtimes", version);
await mkdir(join(base, "runtimes"), { recursive: true });
try {
  await lstat(target);
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  const temporary = target + "." + randomUUID() + ".tmp";
  try {
    await cp(source, temporary, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
const current = join(base, "current");
try {
  const info = await lstat(current);
  if (
    !info.isSymbolicLink() ||
    !(await readlink(current)).startsWith("runtimes/")
  )
    throw new Error("The current desktop path is not an installer-owned link.");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const entryDir = join(data, "applications");
await mkdir(entryDir, { recursive: true });
const entryPath = join(entryDir, "dev.agenticdriver.desktop");
try {
  if (
    !(await readFile(entryPath, "utf8")).includes(
      "X-AgenticDriver-Managed=true",
    )
  )
    throw new Error("Preserving the existing custom AgenticDriver launcher.");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const quote = (path) =>
  '"' +
  path
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("`", "\\`")
    .replaceAll("$", "\\$")
    .replaceAll("%", "%%") +
  '"';
const entry = `[Desktop Entry]\nType=Application\nName=AgenticDriver\nComment=Manage AI providers, usage and application connections\nExec=${quote(join(current, "agenticdriver-desktop"))}\nIcon=${join(current, "resources/app/assets/icon.png")}\nTerminal=false\nCategories=Development;\nStartupWMClass=AgenticDriver\nX-AgenticDriver-Managed=true\n`;
const nextLink = current + "." + randomUUID();
await symlink("runtimes/" + version, nextLink);
await rename(nextLink, current);
await writeFile(entryPath, entry, { mode: 0o644 });
console.log(
  JSON.stringify({
    version,
    executable: join(current, "agenticdriver-desktop"),
    launcher: entryPath,
    keepsPreviousVersions: true,
  }),
);
