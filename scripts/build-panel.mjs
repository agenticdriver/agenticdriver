import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const script =
  (await readFile(new URL("../dist/ui.js", import.meta.url), "utf8")).replace(
    /\n?\/\/# sourceMappingURL=.*$/,
    "",
  ) + "\n";
for (const target of [
  "dist/provider-panel.js",
  "clients/python/src/agenticdriver/static/provider-panel.js",
  "clients/go/provider-panel.js",
  "clients/rust/src/provider-panel.js",
]) {
  const path = new URL("../" + target, import.meta.url);
  await mkdir(dirname(fileURLToPath(path)), { recursive: true });
  await writeFile(path, script);
}
