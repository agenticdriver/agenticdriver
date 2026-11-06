import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { SqliteVectorStore } from "../src/sqlite-vector-store.js";
import {
  MemoryVectorStore,
  type StoredChunk,
  type VectorScope,
} from "../src/vector-store.js";
import type { VectorIndex } from "../src/retrieval-types.js";

// Storage-domain records only: no embedding adapter or generated model response.
const context = () => ({
  runId: "storage-domain",
  subject: "storage-owner",
  signal: new AbortController().signal,
  reportProgress() {},
});
const index: VectorIndex = {
  providerId: "storage-domain",
  vendor: "domain-records",
  accountId: "storage-owner",
  authMode: "none",
  model: "domain-vector",
  dimensions: 2,
  metric: "cosine",
  version: "v1",
};
const scope = (id = "paper-a", namespace = "project-a"): VectorScope => ({
  corpus: "library",
  namespace,
  sources: { [id]: "revision-a" },
});
const document = (id = "paper-a", revision = "revision-a") => ({
  sourceId: id,
  revision,
  digest: "a".repeat(64),
  chunks: 1,
});
const chunks = (id = "paper-a", revision = "revision-a"): StoredChunk[] => [
  {
    chunkId: `${id}-passage`,
    source: { id, revision },
    text: "Public storage-domain passage.",
    documentSha256: "a".repeat(64),
    vector: [1, 0],
  },
];
async function setup(maxSources = 10) {
  const root = await mkdtemp(join(tmpdir(), "retirement-store-")),
    path = join(root, "vectors.sqlite");
  const store = await SqliteVectorStore.open(path, {
    retirement: { maxSources },
  });
  await store.ensureIndex("library", index, context());
  return {
    root,
    path,
    store,
    async close() {
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("retirement removes existing data and permanently fences every revision through reopen", async () => {
  const s = await setup();
  try {
    await s.store.replace(scope(), document(), chunks(), null, context());
    assert.deepEqual(
      await s.store.retire!(scope(), "paper-a", "revision-a", context()),
      { retired: true, deleted: true },
    );
    assert.deepEqual(await s.store.documents(scope(), context()), []);
    assert.equal(
      await s.store.delete(scope(), "paper-a", "revision-a", context()),
      false,
    );
    await assert.rejects(
      s.store.replace(
        scope(),
        document("paper-a", "revision-b"),
        chunks("paper-a", "revision-b"),
        null,
        context(),
      ),
      { code: "SOURCE_RETIRED" },
    );
    await s.store.close();
    const reopened = await SqliteVectorStore.open(s.path, {
      retirement: { maxSources: 10 },
    });
    try {
      assert.deepEqual(
        await reopened.retire!(scope(), "paper-a", "revision-a", context()),
        { retired: true, deleted: false },
      );
      await assert.rejects(
        reopened.replace(scope(), document(), chunks(), null, context()),
        { code: "SOURCE_RETIRED" },
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await s.close();
  }
});

test("persistent guards reject an independently prepared late insert and update, including another process", async () => {
  const s = await setup();
  const older = new DatabaseSync(s.path);
  try {
    older.exec("PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;");
    const late = older.prepare(
      "INSERT INTO ad_vector_documents(corpus,namespace,source_id,revision,digest,chunks,bytes) VALUES(?,?,?,?,?,?,?)",
    );
    assert.deepEqual(
      await s.store.retire!(scope(), "paper-a", "revision-a", context()),
      { retired: true, deleted: false },
    );
    assert.throws(
      () =>
        late.run(
          "library",
          "project-a",
          "paper-a",
          "revision-a",
          "a".repeat(64),
          0,
          0,
        ),
      /SOURCE_RETIRED/,
    );
    late.run(
      "library",
      "project-b",
      "paper-a",
      "revision-a",
      "a".repeat(64),
      0,
      0,
    );
    assert.throws(
      () =>
        older
          .prepare(
            "UPDATE ad_vector_documents SET namespace=? WHERE namespace=?",
          )
          .run("project-a", "project-b"),
      /SOURCE_RETIRED/,
    );
    const result = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[1]);
try {
  db.prepare('INSERT INTO ad_vector_documents VALUES(?,?,?,?,?,?,?)').run('library','project-a','paper-a','revision-a','digest',0,0);
  console.log('inserted');
} catch (error) { console.log(error.message); }
finally { db.close(); }
`,
        s.path,
      ],
      { encoding: "utf8" },
    ).trim();
    assert.equal(result, "SOURCE_RETIRED");
    assert.equal(
      (await s.store.documents(scope("paper-a", "project-b"), context()))
        .length,
      1,
    );
  } finally {
    older.close();
    await s.close();
  }
});

test("retirement capacity and revision conflicts preserve data; duplicates remain acknowledgeable when full", async () => {
  const s = await setup(1);
  try {
    await s.store.replace(
      scope("paper-b"),
      document("paper-b"),
      chunks("paper-b"),
      null,
      context(),
    );
    await s.store.retire!(scope(), "paper-a", "revision-a", context());
    await assert.rejects(
      s.store.retire!(scope(), "paper-a", "revision-b", context()),
      { code: "SOURCE_CONFLICT" },
    );
    await assert.rejects(
      s.store.retire!(scope("paper-b"), "paper-b", "revision-b", context()),
      { code: "SOURCE_CONFLICT" },
    );
    await assert.rejects(
      s.store.retire!(scope("paper-b"), "paper-b", "revision-a", context()),
      { code: "RETIREMENT_FULL" },
    );
    assert.deepEqual(await s.store.documents(scope("paper-b"), context()), [
      document("paper-b"),
    ]);
    assert.deepEqual(
      await s.store.retire!(scope(), "paper-a", "revision-a", context()),
      { retired: true, deleted: false },
    );
  } finally {
    await s.close();
  }
});

test("retirement mode never migrates format one and format two needs explicit opt-in", async () => {
  const root = await mkdtemp(join(tmpdir(), "retirement-formats-"));
  try {
    const legacy = join(root, "legacy.sqlite"),
      modern = join(root, "modern.sqlite");
    const plain = await SqliteVectorStore.open(legacy);
    assert.equal(plain.retire, undefined);
    await plain.close();
    await assert.rejects(
      SqliteVectorStore.open(legacy, { retirement: { maxSources: 10 } }),
      { code: "INDEX_INCOMPATIBLE" },
    );
    const db = new DatabaseSync(legacy);
    try {
      assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 1);
      assert.equal(
        db
          .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'")
          .get()!.n,
        3,
      );
    } finally {
      db.close();
    }
    const fenced = await SqliteVectorStore.open(modern, {
      retirement: { maxSources: 10 },
    });
    await fenced.close();
    await assert.rejects(SqliteVectorStore.open(modern), {
      code: "INDEX_INCOMPATIBLE",
    });
    assert.equal("retire" in new MemoryVectorStore(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const change of ["missing", "altered"] as const)
  test(`format two rejects ${change} persistent fence guards without repairing them`, async () => {
    const s = await setup();
    await s.store.close();
    try {
      const db = new DatabaseSync(s.path);
      try {
        db.exec("DROP TRIGGER ad_vector_retired_insert");
        if (change === "altered")
          db.exec(
            "CREATE TRIGGER ad_vector_retired_insert BEFORE INSERT ON ad_vector_documents BEGIN SELECT 1; END",
          );
      } finally {
        db.close();
      }
      await assert.rejects(
        SqliteVectorStore.open(s.path, { retirement: { maxSources: 10 } }),
        { code: "INDEX_INCOMPATIBLE" },
      );
    } finally {
      await s.close();
    }
  });

test("cancelled retirement does not install a fence and can be reconciled explicitly", async () => {
  const s = await setup();
  try {
    const controller = new AbortController(),
      reason = new Error("cancelled before mutation");
    controller.abort(reason);
    await assert.rejects(
      s.store.retire!(scope(), "paper-a", "revision-a", {
        ...context(),
        signal: controller.signal,
      }),
      (error) => error === reason,
    );
    await s.store.replace(scope(), document(), chunks(), null, context());
    assert.deepEqual(
      await s.store.retire!(scope(), "paper-a", "revision-a", context()),
      { retired: true, deleted: true },
    );
  } finally {
    await s.close();
  }
});

test("mixed-mode initialization cannot downgrade a freshly committed retirement format", async () => {
  const root = await mkdtemp(join(tmpdir(), "retirement-open-race-"));
  const childPath = join(root, "legacy.mjs");
  await writeFile(
    childPath,
    `
    import {DatabaseSync} from 'node:sqlite';
    import fs from 'node:fs';
    const root=process.argv[2];
    const prepare=DatabaseSync.prototype.prepare;
    let paused=false;
    DatabaseSync.prototype.prepare=function(sql,...args){
      const stmt=prepare.call(this,sql,...args);
      if(sql==='PRAGMA user_version'&&!paused){
        const get=stmt.get.bind(stmt);
        stmt.get=(...args)=>{
          const result=get(...args);paused=true;fs.writeFileSync(root+'/ready','');
          const until=Date.now()+15000;
          while(!fs.existsSync(root+'/resume')){
            if(Date.now()>until)throw new Error('parent did not resume opener');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
          }
          return result;
        };
      }
      return stmt;
    };
    const {SqliteVectorStore}=await import(process.argv[3]);
    try{const store=await SqliteVectorStore.open(root+'/index.sqlite');await store.close();console.log('legacy-opened');}
    catch(error){console.log(error.code);}
  `,
  );
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      childPath,
      root,
      new URL("../src/sqlite-vector-store.ts", import.meta.url).href,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  let exited = false;
  const completion = new Promise<void>((resolve) =>
    child.once("exit", () => {
      exited = true;
      resolve();
    }),
  );
  try {
    const until = Date.now() + 10000;
    while (
      !(await access(join(root, "ready")).then(
        () => true,
        () => false,
      ))
    ) {
      assert(!exited, output);
      assert(
        Date.now() < until,
        "child opener did not reach initialization barrier",
      );
      await delay(10);
    }
    const fenced = await SqliteVectorStore.open(join(root, "index.sqlite"), {
      retirement: { maxSources: 10 },
    });
    await fenced.close();
    await writeFile(join(root, "resume"), "");
    await completion;
    assert.match(output, /INDEX_INCOMPATIBLE/);
    const reopened = await SqliteVectorStore.open(join(root, "index.sqlite"), {
      retirement: { maxSources: 10 },
    });
    await reopened.close();
  } finally {
    if (!exited) child.kill();
    await completion;
    await rm(root, { recursive: true, force: true });
  }
});
