/** Inspect an actual installed npm archive, without inventing a provider connection. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = new URL("../", import.meta.url).pathname;
const dir = await mkdtemp(join(tmpdir(), "agenticdriver-package-"));
try {
  const [packed] = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", dir],
      { cwd: root, encoding: "utf8" },
    ),
  );
  const paths = packed.files.map((f) => f.path);
  assert(
    !paths.some((p) => /(?:^|\/)(?:mock|provider-conformance)\.[^/]+$/.test(p)),
    "Removed provider code must never be packaged.",
  );
  await writeFile(
    join(dir, "package.json"),
    '{"private":true,"type":"module"}',
  );
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(dir, packed.filename),
    ],
    { cwd: dir, stdio: "pipe" },
  );
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
   import assert from 'node:assert/strict';
   import * as providers from '@agenticdriver/sdk/providers';
   import * as retrieval from '@agenticdriver/sdk/retrieval';
   import { createRequire } from 'node:module';
   import { validateHostConfig } from '@agenticdriver/sdk/host';
   import { providerPanelHtml } from '@agenticdriver/sdk/ui';
   assert(!('mockProvider' in providers));
   assert(!('DeterministicEmbeddingAdapter' in retrieval));
   assert.equal(typeof retrieval.LocalEmbeddingAdapter, 'function');
   assert.throws(() => createRequire(import.meta.url).resolve('@huggingface/transformers'), {code:'MODULE_NOT_FOUND'});
   assert(providerPanelHtml().includes('agenticdriver-providers'));
   assert.deepEqual(validateHostConfig({version:1,providers:[]}).providers,[]);
   await assert.rejects(import('@agenticdriver/sdk/provider-conformance'),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
 `,
    ],
    { cwd: dir, stdio: "pipe" },
  );
  console.log(
    "Fresh npm installation: real provider exports, empty configuration and panel verified; removed adapters absent.",
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
