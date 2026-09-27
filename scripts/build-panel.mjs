import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
// The portable component ships in all language packages and the desktop renderer.
// Bundle its canonical icon dependency so consumers need no runtime module loader.
await build({entryPoints: [new URL("../dist/ui.js", import.meta.url).pathname], outfile: new URL("../dist/ui.js", import.meta.url).pathname, bundle: true, format: "esm", platform: "browser", allowOverwrite: true});
const iconRoot = new URL("./", import.meta.resolve("@agenticdriver/provider-icons"));
const notice = (await Promise.all(["NOTICE", "LICENSE", "licenses/LobeHub-MIT.txt", "licenses/CodexBar-MIT.txt", "licenses/UsageStat-Bar-MIT.txt"].map(name => readFile(new URL(name, iconRoot), "utf8")))).join("\n\n");
const script =
  (await readFile(new URL("../dist/ui.js", import.meta.url), "utf8")).replace(
    /\n?\/\/# sourceMappingURL=.*$/,
    "",
  ).trimEnd() + "\n";
for (const target of [
  "dist/provider-panel.js",
  "clients/python/src/agenticdriver/static/provider-panel.js",
  "clients/go/provider-panel.js",
  "clients/rust/src/provider-panel.js",
]) {
  const path = new URL("../" + target, import.meta.url);
  await mkdir(dirname(fileURLToPath(path)), { recursive: true });
  await writeFile(path, script);
  await writeFile(new URL("provider-icons.NOTICE.txt", path), notice);
}
