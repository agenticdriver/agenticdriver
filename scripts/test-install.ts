import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CliProcess } from "../tests/cli-helpers.js";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "agenticdriver-install-"));
const app = join(directory, "application");
const env = {
  ...process.env,
  AD_INSTALL_API_KEY: "install-test-key-not-a-real-account",
};
let generations = 0,
  modelQueries = 0;
const bodies: Record<string, unknown>[] = [];
let providerStarted!: () => void;
const providerPending = new Promise<void>((resolve) => {
  providerStarted = resolve;
});
let providerCancelled!: () => void;
const cancelled = new Promise<void>((resolve) => {
  providerCancelled = resolve;
});
const fixture = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, `Bearer ${env.AD_INSTALL_API_KEY}`);
  if (req.url === "/v1/models" && req.method === "GET") {
    modelQueries++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "explicit-fixture-model" }] }));
    return;
  }
  assert.equal(req.url, "/v1/responses");
  assert.equal(req.method, "POST");
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body) as Record<string, unknown>;
  assert.equal(request.model, "explicit-fixture-model");
  bodies.push(request);
  generations++;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.flushHeaders();
  if (body.includes("wait-until-shutdown")) {
    res.once("close", providerCancelled);
    providerStarted();
    return;
  }
  for (const event of [
    {
      type: "response.output_text.delta",
      delta: "Installed API adapter connected.",
    },
    {
      type: "response.completed",
      response: {
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: "Installed API adapter connected." },
            ],
          },
        ],
        usage: { input_tokens: 2, output_tokens: 4 },
      },
    },
  ])
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
});
const hosts: CliProcess[] = [];
try {
  // These are local package creation/installation, never a registry publication.
  await run("npm", ["pack", "--pack-destination", directory, "--silent"], {
    cwd: root,
    timeout: 120_000,
    maxBuffer: 2_000_000,
  });
  const archive = (await readdir(directory)).find((name) =>
    name.endsWith(".tgz"),
  );
  assert.ok(archive);
  await run(
    "npm",
    [
      "install",
      "--prefix",
      app,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(directory, archive),
    ],
    { cwd: directory, timeout: 120_000, maxBuffer: 2_000_000 },
  );
  // Verify the context export and a draft round trip from the installed artifact.
  await writeFile(
    join(app, "context-check.mjs"),
    `
    import assert from "node:assert/strict";
    import {AgenticDriver} from "agenticdriver";
    import {MemoryContextStore} from "agenticdriver/context";
    import {mockProvider} from "agenticdriver/providers";
    const store=new MemoryContextStore();
    const attachment=store.put({attachment:{type:"text",source:{id:"installed-source",revision:"r1"},mediaType:"text/markdown",text:"Selected document"},subjects:["local"],expiresAt:new Date(Date.now()+60000).toISOString()});
    const driver=new AgenticDriver({providers:[mockProvider()],context:{resolve:store.resolve}});
    const result=await driver.run({provider:"mock",model:"demo",input:"Summarize",attachments:[attachment],outputArtifact:{name:"answer.md",mediaType:"text/markdown"}});
    assert.equal(result.sources[0].id,"installed-source");assert.equal(result.artifacts[0].status,"draft");store.clear();
  `,
  );
  await run(process.execPath, [join(app, "context-check.mjs")], {
    cwd: app,
    timeout: 10000,
  });
  await writeFile(
    join(app, "retrieval-check.mjs"),
    `
    import assert from "node:assert/strict";
    import {AgenticDriver} from "agenticdriver";
    import {fileURLToPath} from "node:url";
    import {RetrievalService,SqliteVectorStore,DeterministicEmbeddingAdapter} from "agenticdriver/retrieval";
    import {mockProvider} from "agenticdriver/providers";
    const store=await SqliteVectorStore.open(fileURLToPath(new URL("./private-state/vectors.db",import.meta.url)));
    const retrieval=new RetrievalService([{id:"library",version:"v1",store,embedding:new DeterministicEmbeddingAdapter(32),
      authorize:()=>({namespace:"local",sources:{paper:"r1"}})}]);
    const driver=new AgenticDriver({providers:[mockProvider()],retrieval});
    await driver.indexContext({corpus:"library",source:{id:"paper",revision:"r1"},chunks:[{id:"p1",text:"Solar batteries retain energy."}]});
    const result=await driver.run({provider:"mock",model:"demo",input:"solar energy",retrieval:{corpus:"library",sourceIds:["paper"]}});
    assert.equal(result.retrieval.hits[0].chunkId,"p1");assert.equal(result.sources[0].origin,"retrieval");await store.close();
  `,
  );
  await run(process.execPath, [join(app, "retrieval-check.mjs")], {
    cwd: app,
    timeout: 10000,
  });
  const bin = join(app, "node_modules", ".bin", "agenticdriver");
  const entry =
    process.platform === "win32"
      ? join(app, "node_modules", "agenticdriver", "dist", "cli.js")
      : bin;
  await access(
    process.platform === "win32" ? bin + ".cmd" : bin,
    process.platform === "win32" ? constants.F_OK : constants.X_OK,
  );
  const cli = (args: string[], input?: string) =>
    new CliProcess([entry], args, { cwd: directory, env, input });
  const version = await cli(["--version"]).finished;
  assert.equal(version.code, 0, version.stderr);
  assert.equal(
    version.stdout.trim(),
    JSON.parse(await readFile(join(root, "package.json"), "utf8")).version,
  );
  const mockPath = join(directory, "mock", "config.json");
  assert.equal(
    (await cli(["init", "--config", mockPath, "--json"]).finished).code,
    0,
  );
  assert.equal(
    (await cli(["doctor", "--config", mockPath, "--json"]).finished).code,
    0,
  );
  const mock = cli(["serve", "--config", mockPath, "--port", "0", "--json"]);
  hosts.push(mock);
  const mockUrl = await mock.listening();
  const mockRun = await cli([
    "run",
    "--config",
    mockPath,
    "--url",
    mockUrl,
    "--provider",
    "mock",
    "--model",
    "demo",
    "--input",
    "hello",
  ]).finished;
  assert.equal(mockRun.code, 0, mockRun.stderr);
  assert.equal(mockRun.stdout.trim(), "AgenticDriver is connected.");
  assert.equal((await mock.stop()).code, 0);

  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address();
  assert.ok(address && typeof address !== "string");
  const configPath = join(directory, "api", "config.json");
  const init = await cli([
    "init",
    "--config",
    configPath,
    "--provider",
    "openai",
    "--provider-id",
    "selected-account",
    "--model",
    "explicit-fixture-model",
    "--api-key-env",
    "AD_INSTALL_API_KEY",
    "--base-url",
    `http://127.0.0.1:${address.port}/v1`,
    "--json",
  ]).finished;
  assert.equal(init.code, 0, init.stderr);
  const cfg = JSON.parse(await readFile(configPath, "utf8"));
  cfg.usageLog = "state/usage.jsonl";
  await writeFile(configPath, JSON.stringify(cfg));
  const doctor = await cli(["doctor", "--config", configPath, "--json"])
    .finished;
  assert.equal(doctor.code, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).providers[0].id, "selected-account");
  assert.equal(
    (doctor.stdout + doctor.stderr).includes(env.AD_INSTALL_API_KEY),
    false,
  );
  const server = cli([
    "serve",
    "--config",
    configPath,
    "--port",
    "0",
    "--json",
  ]);
  hosts.push(server);
  const url = await server.listening();
  const options = [
    "--config",
    configPath,
    "--url",
    url,
    "--provider",
    "selected-account",
    "--model",
    "explicit-fixture-model",
    "--json",
  ];
  const first = await cli(
    ["run", ...options, "--idempotency-key", "installed-run"],
    "hello",
  ).finished;
  assert.equal(first.code, 0, first.stderr);
  const result = JSON.parse(first.stdout.trim().split("\n").at(-1)!).result;
  assert.equal(result.text, "Installed API adapter connected.");
  const again = await cli(
    ["run", ...options, "--idempotency-key", "installed-run"],
    "hello",
  ).finished;
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(
    JSON.parse(again.stdout.trim().split("\n").at(-1)!).result,
    result,
  );
  assert.equal(generations, 1);
  assert.equal(modelQueries, 1);
  assert.ok(bodies.every((body) => body.model === "explicit-fixture-model"));
  const hanging = cli([
    "run",
    ...options,
    "--idempotency-key",
    "shutdown-run",
    "--input",
    "wait-until-shutdown",
  ]);
  await Promise.race([
    providerPending,
    hanging.finished.then(() => {
      throw new Error("Expected an active provider request before shutdown");
    }),
  ]);
  assert.equal((await server.stop()).code, 0);
  assert.equal((await hanging.finished).code, 1);
  await Promise.race([
    cancelled,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Provider connection was not cancelled")),
        5000,
      );
      timer.unref();
    }),
  ]);
  const restarted = cli([
    "serve",
    "--config",
    configPath,
    "--port",
    "0",
    "--json",
  ]);
  hosts.push(restarted);
  const restartedUrl = await restarted.listening();
  const recovered = await cli([
    "run",
    "--config",
    configPath,
    "--url",
    restartedUrl,
    "--provider",
    "selected-account",
    "--model",
    "explicit-fixture-model",
    "--idempotency-key",
    "shutdown-run",
    "--input",
    "wait-until-shutdown",
    "--json",
  ]).finished;
  assert.equal(recovered.code, 1);
  assert.equal(JSON.parse(recovered.stderr).error.code, "CANCELLED");
  assert.equal(
    generations,
    2,
    "Restart recovery must not invoke the provider again",
  );
  const records = (
    await readFile(join(directory, "api", "state", "usage.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.equal(JSON.stringify(records).includes(env.AD_INSTALL_API_KEY), false);
  assert.equal((await restarted.stop()).code, 0);
  process.stdout.write(
    "Installed tarball passed: executable CLI, fresh mock, explicit API fixture, secret redaction, idempotent replay, cancellation and restart recovery.\n",
  );
} finally {
  for (const host of hosts) await host.stop();
  fixture.closeAllConnections();
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
