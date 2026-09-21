import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { packageContract } from "../tests/package-contract.js";

const run = promisify(execFile);
const root = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const args = process.argv.slice(2);
assert.ok(
  args.length === 0 || (args.length === 2 && args[0] === "--receipt"),
  "Usage: npm run test:package -- [--receipt /path/to/receipt.json]",
);
const receiptPath = args[1] ? resolve(args[1]) : undefined;
const directory = await realpath(
  await mkdtemp(join(tmpdir(), "agenticdriver-package-")),
);
const app = join(directory, "consumer");
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const env: NodeJS.ProcessEnv = {
  // No provider credentials, NODE_PATH/loaders, user npmrc or account tokens.
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  WINDIR: process.env.WINDIR,
  ComSpec: process.env.ComSpec,
  PATHEXT: process.env.PATHEXT,
  TMPDIR: directory,
  TEMP: directory,
  TMP: directory,
  npm_config_cache: join(directory, "npm-cache"),
  npm_config_userconfig: join(directory, "npmrc"),
  npm_config_globalconfig: join(directory, "global-npmrc"),
  npm_config_registry: "https://registry.npmjs.org/",
  CI: "true",
};
async function command(binary: string, argv: string[], cwd: string) {
  try {
    return await run(binary, argv, {
      cwd,
      env,
      timeout: 120_000,
      maxBuffer: 4_000_000,
    });
  } catch (error) {
    const detail = error as Error & { stdout?: string; stderr?: string };
    const output = argv.includes("--listFiles")
      ? detail.stdout
          ?.split(/\r?\n/)
          .filter((line) => !isAbsolute(line))
          .join("\n")
      : detail.stdout;
    throw new Error(
      `${binary} ${argv.join(" ")} failed\n${output ?? ""}${detail.stderr ?? ""}\n${detail.message}`,
    );
  }
}
function localTo(parent: string, path: string) {
  const local = relative(parent, path);
  return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

try {
  await mkdir(app);
  await writeFile(
    join(directory, "npmrc"),
    "registry=https://registry.npmjs.org/\n",
  );
  await writeFile(join(directory, "global-npmrc"), "");
  const lockBytes = await readFile(join(root, "package-lock.json"));
  const lock = JSON.parse(lockBytes.toString()) as {
    packages: Record<string, { version: string }>;
  };
  const sourceCommit = (
    await command("git", ["rev-parse", "HEAD"], root)
  ).stdout.trim();
  const sourceStatus = (await command("git", ["status", "--porcelain"], root))
    .stdout;
  const npmVersion = (
    await command("npm", ["--version"], directory)
  ).stdout.trim();
  const archives: { filename: string; files: { path: string }[] }[] = [];
  const archiveBytes: Buffer[] = [];
  // Clean generated output on both builds so removed files cannot survive in a pack.
  for (const iteration of [0, 1]) {
    const destination = join(directory, `pack-${iteration}`);
    await mkdir(destination);
    await rm(join(root, "dist"), { recursive: true, force: true });
    await command("npm", ["run", "build"], root);
    const packed = await command(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
      root,
    );
    const [archive] = JSON.parse(packed.stdout);
    assert.ok(archive?.filename);
    archives.push(archive);
    archiveBytes.push(await readFile(join(destination, archive.filename)));
  }
  assert.deepEqual(
    archiveBytes[0],
    archiveBytes[1],
    "Repeated clean builds must produce identical archive bytes",
  );
  const archive = archives[0]!;
  assert.ok(archive.files.some((file) => file.path === "dist/index.js"));
  assert.ok(archive.files.some((file) => file.path === "dist/index.d.ts"));
  for (const file of archive.files) {
    assert.ok(
      !/^(src|tests|scripts|node_modules|\.git)\//.test(file.path),
      `Unexpected development file: ${file.path}`,
    );
  }
  await writeFile(
    join(app, "package.json"),
    JSON.stringify(
      {
        name: "agenticdriver-external-package-contract",
        private: true,
        type: "module",
        dependencies: { agenticdriver: `file:../pack-0/${archive.filename}` },
        devDependencies: {
          typescript: lock.packages["node_modules/typescript"]!.version,
          "@types/node": lock.packages["node_modules/@types/node"]!.version,
        },
      },
      null,
      2,
    ),
  );
  await command(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    app,
  );
  const installed = join(app, "node_modules", "agenticdriver");
  assert.equal(
    await realpath(installed),
    installed,
    "SDK installation must not be a source symlink",
  );
  const manifest = JSON.parse(
    await readFile(join(installed, "package.json"), "utf8"),
  ) as {
    name: string;
    version: string;
    exports: Record<string, { import: string; types: string }>;
  };
  const entryImports: string[] = [];
  const declarationPaths: string[] = [];
  for (const [key, target] of Object.entries(manifest.exports)) {
    const name = key === "." ? manifest.name : manifest.name + key.slice(1);
    for (const file of [target.import, target.types]) {
      assert.ok(
        file?.startsWith("./dist/"),
        `Missing distribution target: ${name}`,
      );
      const path = await realpath(join(installed, file));
      assert.ok(
        localTo(join(installed, "dist"), path),
        `Export escaped installed package: ${name}`,
      );
    }
    declarationPaths.push(await realpath(join(installed, target.types)));
    const alias = `entry${entryImports.length}`;
    entryImports.push(
      `import * as ${alias} from ${JSON.stringify(name)};\nvoid ${alias};`,
    );
  }
  await writeFile(join(app, "entrypoints.mts"), entryImports.join("\n"));
  await writeFile(join(app, "contract.mts"), packageContract);
  await writeFile(
    join(app, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: false,
        outDir: "build",
        types: ["node"],
      },
      include: ["*.mts"],
    }),
  );
  const compiled = await command(
    process.execPath,
    [
      join(app, "node_modules", "typescript", "bin", "tsc"),
      "--listFiles",
      "-p",
      "tsconfig.json",
    ],
    app,
  );
  const typeFiles = compiled.stdout.trim().split(/\r?\n/);
  for (const path of typeFiles) {
    assert.ok(
      localTo(app, await realpath(path)),
      `TypeScript read outside the consumer: ${path}`,
    );
  }
  for (const path of declarationPaths)
    assert.ok(typeFiles.includes(path), `Declaration not checked: ${path}`);
  const contract = await command(process.execPath, ["build/contract.mjs"], app);
  const receipt = {
    schemaVersion: 1,
    status: "passed",
    source: {
      commit: sourceCommit,
      dirty: sourceStatus.length > 0,
      lockfileSha256: sha256(lockBytes),
    },
    artifact: {
      name: manifest.name,
      version: manifest.version,
      filename: archive.filename,
      sha256: sha256(archiveBytes[0]!),
      bytes: archiveBytes[0]!.length,
      repeatedCleanBuilds: 2,
    },
    environment: {
      node: process.version,
      npm: npmVersion,
      platform: process.platform,
      arch: process.arch,
    },
    consumer: {
      lockfileSha256: sha256(await readFile(join(app, "package-lock.json"))),
      typescript: lock.packages["node_modules/typescript"]!.version,
      nodeTypes: lock.packages["node_modules/@types/node"]!.version,
      declarationFiles: declarationPaths.map((path) =>
        relative(installed, path).split(sep).join("/"),
      ),
      allCompilerInputsInsideConsumer: true,
      lifecycleScripts: false,
      ...JSON.parse(contract.stdout),
    },
  };
  const output = JSON.stringify(receipt, null, 2) + "\n";
  if (receiptPath) await writeFile(receiptPath, output, { mode: 0o600 });
  process.stdout.write(output);
} finally {
  await rm(directory, { recursive: true, force: true });
}
