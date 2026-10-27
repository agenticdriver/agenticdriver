import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  AgenticClient,
  SqliteJobStore,
  UsageRecordSchema,
} from "@agenticdriver/sdk";
import {
  configuredDriver,
  configuredServer,
  validateHostConfig,
} from "@agenticdriver/sdk/host";
import { serve } from "@agenticdriver/sdk/server";

const [
  savedArgument,
  provider,
  model,
  outputArgument,
  sourceCommit,
  archiveSha256,
] = process.argv.slice(2);
assert.ok(
  savedArgument &&
    provider &&
    model &&
    outputArgument &&
    /^[a-f0-9]{40}$/.test(sourceCommit ?? "") &&
    /^[a-f0-9]{64}$/.test(archiveSha256 ?? ""),
  "Supply saved config, exact provider/model, NEW private output directory, source commit and private archive SHA256.",
);
const savedPath = resolve(savedArgument),
  output = resolve(outputArgument);
await mkdir(output, { mode: 0o700 }); // Existing output refuses a new invocation rather than replaying model work.
const receiptPath = join(output, "receipt.json"),
  configPath = join(output, "config.json"),
  jobsPath = join(output, "jobs.sqlite"),
  tokenPath = join(output, "operator.token");
const checkOnly = process.argv.includes("--check-only");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const receipt = {
  status: "preparing",
  candidate: "unreleased-development",
  sourceCommit,
  archiveSha256,
  provider,
  model,
  startedAt: new Date().toISOString(),
  callsSubmitted: 0,
};
const save = () =>
  writeFile(receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600 });
await save();
async function prepare() {
  const raw = await readFile(savedPath),
    saved = validateHostConfig(JSON.parse(raw));
  receipt.sourceConfigSha256 = sha(raw);
  const selected = saved.providers.find((item) => item.id === provider);
  assert.ok(
    selected?.kind === "codex" &&
      selected.binary &&
      selected.accountDirectory &&
      selected.accountId &&
      saved.usage?.hostId,
    "Select the existing explicitly bound Codex native connection; no alternate account/runtime is chosen.",
  );
  assert.equal(
    selected.reasoningEffort,
    "medium",
    "Preserve the established inexpensive reasoning selection.",
  );
  assert.equal(
    model,
    "gpt-6-luna",
    "This bounded qualifier uses the established inexpensive Codex model only.",
  );
  assert.ok(
    !saved.usagestat,
    "Use a separate test log; this qualifier does not change shared ingestion configuration.",
  );
  const binary = resolve(dirname(savedPath), selected.binary),
    accountDirectory = resolve(dirname(savedPath), selected.accountDirectory);
  const run = promisify(execFile),
    environment = { ...process.env, CODEX_HOME: accountDirectory };
  async function control(args) {
    try {
      return await run(binary, args, { env: environment, timeout: 20_000 });
    } catch {
      throw new Error(
        "Native runtime preflight failed; inspect its private execution-host setup. No model was requested.",
      );
    }
  }
  const login = await control(["login", "status"]);
  assert.ok(
    /logged in using chatgpt/i.test(login.stdout + login.stderr),
    "A current native subscription sign-in is required.",
  );
  const version = await control(["--version"]);
  assert.ok(
    !selected.models || selected.models.includes(model),
    "The selected model must remain allowed by the existing connection policy.",
  );
  const token = randomBytes(32).toString("hex"),
    subject = `handoff-${randomUUID()}`;
  await writeFile(tokenPath, token, { mode: 0o600, flag: "wx" });
  const config = validateHostConfig({
    ...saved,
    providers: [{ ...selected, binary, accountDirectory }],
    tokens: [
      {
        id: "handoff-qualifier",
        subject,
        providers: [provider],
        jobs: ["submit", "read", "cancel"],
        tokenRef: { file: tokenPath },
      },
    ],
    listen: { host: "127.0.0.1", port: 0 },
    clientUrl: undefined,
    usageLog: join(output, "usage.jsonl"),
    operations: saved.operations
      ? { ...saved.operations, directory: join(output, "operations") }
      : undefined,
    jobs: {
      path: jobsPath,
      retentionMs: 86_400_000,
      maxJobs: 10,
      maxJobsPerSubject: 10,
      worker: { maxWorkers: 1 },
    },
  });
  await writeFile(configPath, JSON.stringify(config, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
  const prompt =
    "Create three distinct brand directions for a repairable 18-litre commuter backpack for Amsterdam cyclists. Audience: urban professionals aged 25–40. The brief specifies recycled fabric, replaceable buckles, laptop protection and a €120–€160 price. For each direction give a name, short tagline and one positioning sentence. Avoid certifications or performance claims absent from the brief. Return a concise list. Do not browse, inspect files, run tools or write files.";
  const request = {
    provider,
    model,
    input: prompt,
    maxSteps: 1,
    maxOutputTokens: 512,
  };
  Object.assign(receipt, {
    reasoning: selected.reasoningEffort,
    billing: "native-subscription",
    cliVersion: version.stdout.trim(),
    prompt,
  });
  return { config, token, request, subject, selected };
}
let server,
  client,
  attempted = false,
  terminal = false;
async function start(config, token) {
  const settings = await configuredServer(config, configPath);
  assert.ok(settings.jobs);
  settings.jobs.handoff = {
    snapshot: (await SqliteJobStore.inspect(jobsPath)).snapshot,
  };
  server = await serve(configuredDriver(config, configPath), settings);
  client = new AgenticClient({ url: server.url, token });
  await writeFile(
    join(output, "profile.json"),
    JSON.stringify({ url: server.url, tokenFile: tokenPath }),
    { mode: 0o600 },
  );
}
async function events(id) {
  const items = [];
  let after = 0;
  for (;;) {
    const page = await client.jobEvents({ id, after, limit: 100 });
    items.push(...page.events);
    if (!page.hasMore) return items;
    assert.ok(page.nextCursor > after);
    after = page.nextCursor;
  }
}
try {
  const { config, token, request, subject, selected } = await prepare();
  // Public storage operations prepare one cancelled legacy record; no provider dispatch or result is fabricated.
  const prepared = await configuredServer(config, configPath);
  assert.equal(typeof prepared.jobs?.store, "function");
  const original = await prepared.jobs.store();
  try {
    const prior = await original.submit({
      subject,
      principal: "storage-prerequisite",
      keyHash: sha("storage-prerequisite"),
      fingerprint: sha(JSON.stringify(request)),
      account: { hostId: config.usage.hostId, accountId: selected.accountId },
      request,
    });
    await original.cancel(subject, prior.info.id);
    receipt.priorJobId = prior.info.id;
  } finally {
    await original.close?.();
  }
  await start(config, token);
  const connection = (await client.providers({ refresh: true })).find(
    (item) => item.id === provider,
  );
  assert.ok(
    connection?.modelCatalog?.source === "provider" &&
      connection.modelCatalog.models.includes(model),
    "Selected account must currently report the exact model.",
  );
  assert.equal(connection.connection?.account?.status, "signed-in");
  assert.equal(connection.connection?.source, "native-runtime");
  receipt.connection = {
    runtime: connection.connection.runtime,
    method: connection.connection.account.method,
    subscription: connection.connection.account.subscription,
    modelCatalogSource: connection.modelCatalog?.source,
  };
  assert.match(
    receipt.connection.subscription ?? "",
    /\bpro\b/i,
    "Preserve the existing native Pro billing route.",
  );
  if (checkOnly) {
    receipt.status = "connection-checked";
  } else {
    receipt.status = "submitting";
    await save();
    console.log(
      JSON.stringify({
        stage: "submit",
        receipt: receiptPath,
        provider,
        model,
        cliVersion: receipt.cliVersion,
      }),
    );
    receipt.submitKey = `brand-${randomUUID()}`;
    attempted = true;
    receipt.callsSubmitted = 1;
    await save();
    const job = await client.submitJob({ key: receipt.submitKey, request });
    receipt.job = job;
    await save();
    let current = job;
    while (current.state === "queued" || current.state === "running") {
      await delay(250);
      current = await client.readJob({ id: job.id });
    }
    terminal = true;
    receipt.terminal = current;
    const before = await events(job.id);
    receipt.eventsSha256 = sha(JSON.stringify(before));
    const completed = before.find((event) => event.type === "run.completed");
    assert.equal(current.state, "completed");
    assert.ok(completed?.result?.text?.trim());
    receipt.result = completed.result;
    await save();
    await server.close();
    server = undefined;
    receipt.afterClose = await SqliteJobStore.inspect(jobsPath);
    assert.equal(receipt.afterClose.acceptedKeys, 2);
    assert.equal(receipt.afterClose.quiet, true);
    await start(config, token);
    assert.deepEqual(await client.readJob({ id: job.id }), current);
    assert.deepEqual(await events(job.id), before);
    assert.equal(
      (await client.readJob({ id: receipt.priorJobId })).state,
      "cancelled",
    );
    await server.close();
    server = undefined;
    const capturedText = (await readFile(config.usageLog, "utf8")).trim();
    const captured = capturedText
      ? capturedText
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => UsageRecordSchema.parse(JSON.parse(line)))
      : [];
    assert.equal(
      captured.length,
      1,
      "Observation and restart must not add another metered native run.",
    );
    const usage = captured[0];
    assert.equal(usage.runId, job.runId);
    assert.equal(usage.provider, provider);
    assert.equal(usage.model, model);
    assert.equal(usage.hostId, config.usage.hostId);
    assert.equal(usage.accountId, selected.accountId);
    assert.equal(usage.subject, subject);
    assert.equal(usage.authMode, "cli-session");
    assert.equal(usage.source, "cli-report");
    assert.equal(usage.status, "completed");
    assert.deepEqual(usage.usage, completed.result.usage);
    assert.equal(usage.coverage.startedSteps, 1);
    assert.equal(usage.coverage.completedSteps, 1);
    receipt.usageRecords = captured.length;
    receipt.usageRecord = usage;
    receipt.status = "passed";
  }
} catch (error) {
  receipt.status = attempted && !terminal ? "preserved-uncertain" : "failed";
  receipt.error = {
    code: error?.code ?? error?.name ?? "ERROR",
    message: String(error?.message ?? "Qualification failed"),
  };
  // An uncertain acknowledgement/active job retains its live host, job store and private profile. Never retry it.
} finally {
  if (!attempted || terminal) {
    try {
      await server?.close();
    } catch (error) {
      receipt.status = "failed";
      receipt.cleanupError = { code: error?.code ?? error?.name ?? "ERROR" };
    }
  }
  if (receipt.sourceConfigSha256) {
    try {
      receipt.sourceConfigUnchanged =
        sha(await readFile(savedPath)) === receipt.sourceConfigSha256;
    } catch {
      receipt.sourceConfigUnchanged = false;
    }
    if (
      !receipt.sourceConfigUnchanged &&
      ["passed", "connection-checked"].includes(receipt.status)
    ) {
      receipt.status = "failed";
      receipt.error = {
        code: "SOURCE_CONFIG_CHANGED",
        message: "Saved configuration changed during qualification.",
      };
    }
  }
  receipt.finishedAt = new Date().toISOString();
  await save();
  console.log(
    JSON.stringify({
      status: receipt.status,
      receipt: receiptPath,
      preservedHost: Boolean(server && attempted && !terminal),
      jobId: receipt.job?.id,
      runId: receipt.job?.runId,
      usage: receipt.result?.usage,
      sourceConfigUnchanged: receipt.sourceConfigUnchanged,
    }),
  );
  if (receipt.status === "failed") process.exitCode = 1;
}
