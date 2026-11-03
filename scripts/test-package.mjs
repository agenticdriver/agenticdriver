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
   import { SqliteJobStore } from '@agenticdriver/sdk';
   import { join } from 'node:path';
   assert(!('mockProvider' in providers));
   assert(!('DeterministicEmbeddingAdapter' in retrieval));
   assert.equal(typeof retrieval.LocalEmbeddingAdapter, 'function');
   assert.throws(() => createRequire(import.meta.url).resolve('@huggingface/transformers'), {code:'MODULE_NOT_FOUND'});
   assert(providerPanelHtml().includes('agenticdriver-providers'));
   assert.deepEqual(validateHostConfig({version:1,providers:[]}).providers,[]);
   await assert.rejects(import('@agenticdriver/sdk/provider-conformance'),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
   const jobsPath = join(process.cwd(), 'jobs.sqlite');
   const jobs = await SqliteJobStore.open(jobsPath, {retentionMs:60000});
   try {
     const before = await SqliteJobStore.inspect(jobsPath);
     const owned = await jobs.acquireQuiet('installed-package', 60000, before.snapshot);
     try { await owned.release('installed-package'); }
     finally { await owned.close(); }
     const after = await SqliteJobStore.inspect(jobsPath);
     assert.equal(after.quiet, true);
     assert.equal(after.lease, 'none');
     assert.equal(after.acceptedKeys, 0);
   } finally { await jobs.close(); }
   const vectorPath = join(process.cwd(), 'vectors.sqlite');
   const vectors = await retrieval.SqliteVectorStore.open(vectorPath);
   await vectors.close();
   const reopened = await retrieval.SqliteVectorStore.open(vectorPath);
   await reopened.close();
 `,
    ],
    { cwd: dir, stdio: "pipe" },
  );
  console.log(
    "Fresh npm installation: provider exports, empty configuration, panel and SQLite storage lifecycle verified; removed adapters absent.",
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
