import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgenticDriver } from "../src/driver.js";
import { AgenticClient } from "../src/client.js";
import {
  FileOperationStore,
  MemoryOperationStore,
  newOperation,
  operationKey,
  type OperationStore,
} from "../src/operations.js";
import { mockProvider } from "../src/providers/mock.js";
import { serve } from "../src/server.js";
import type { RunEvent, Tool } from "../src/types.js";

const request = {
  provider: "mock",
  model: "demo",
  input: "hello",
  idempotencyKey: "operation-1",
};
const token = "operation-test-token-at-least-32-characters";
const writeTool = (execute: Tool["execute"]): Tool => ({
  name: "write",
  description: "Record an effect",
  inputSchema: { type: "object" },
  execute,
});

test("idempotency deduplicates runs and telemetry, rejects changed payloads, and scopes keys by subject", async () => {
  let calls = 0,
    usage = 0;
  const driver = new AgenticDriver({
    operations: new MemoryOperationStore(),
    providers: [
      mockProvider(() => {
        calls++;
        return { text: "done" };
      }),
    ],
    onUsage: () => {
      usage++;
    },
  });
  const first = await driver.run(
    { ...request, metadata: { a: "1", b: "2" } },
    { subject: "alice" },
  );
  const second = await driver.run(
    { ...request, metadata: { b: "2", a: "1" } },
    { subject: "alice" },
  );
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
  assert.equal(usage, 1);
  await assert.rejects(
    driver.run({ ...request, input: "changed" }, { subject: "alice" }),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  await driver.run(request, { subject: "bob" });
  assert.equal(calls, 2);
  await assert.rejects(
    new AgenticDriver({ providers: [mockProvider()] }).run(request),
    { code: "IDEMPOTENCY_UNAVAILABLE" },
  );
});

test("accepted active and interrupted runs are never started again", async () => {
  let calls = 0;
  const driver = new AgenticDriver({
    operations: new MemoryOperationStore(),
    providers: [
      mockProvider(() => {
        calls++;
        return { text: "done" };
      }),
    ],
  });
  const stream = driver.stream(request);
  assert.equal((await stream.next()).value?.type, "run.started");
  await assert.rejects(driver.run(request), { code: "OPERATION_IN_PROGRESS" });
  await stream.return(undefined);
  await assert.rejects(driver.run(request), { code: "OPERATION_UNCERTAIN" });
  assert.equal(calls, 0);
});

test("cancellation during a durable claim remains replayable with a valid stream envelope", async () => {
  const memory = new MemoryOperationStore();
  const controller = new AbortController();
  const driver = new AgenticDriver({
    operations: {
      async claim(...args) {
        controller.abort();
        await delay(1);
        return memory.claim(...args);
      },
    },
    providers: [
      mockProvider(() => {
        assert.fail("Cancelled claims must not execute");
      }),
    ],
  });
  await assert.rejects(driver.run(request, { signal: controller.signal }), {
    code: "CANCELLED",
  });
  const events: RunEvent[] = [];
  for await (const event of driver.stream(request)) events.push(event);
  assert.equal(events[0]!.type, "run.started");
  assert.equal(events.at(-1)!.type, "run.cancelled");
  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 2],
  );
});

test("remote conflicts are typed before SSE headers and completed replay works across transports", async () => {
  let calls = 0;
  const driver = new AgenticDriver({
    operations: new MemoryOperationStore(),
    providers: [
      mockProvider(() => {
        calls++;
        return { text: "done" };
      }),
    ],
  });
  const server = await serve(driver, {
    port: 0,
    tokens: [{ token, subject: "alice", providers: ["mock"] }],
  });
  try {
    const client = new AgenticClient({ url: server.url, token });
    assert((await client.protocol()).features.includes("idempotency"));
    const first = await client.run(request);
    const replay = await fetch(server.url + "/v1/runs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });
    assert.deepEqual(await replay.json(), first);
    assert.equal(calls, 1);
    await assert.rejects(client.run({ ...request, input: "changed" }), {
      code: "IDEMPOTENCY_CONFLICT",
    });
  } finally {
    await server.close();
  }
});

test("completed file records survive a new driver and store, with private files and atomic key ownership", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agenticdriver-operations-"));
  try {
    let calls = 0;
    const adapter = mockProvider(() => {
      calls++;
      return { text: "done" };
    });
    const first = await new AgenticDriver({
      operations: new FileOperationStore(dir),
      providers: [adapter],
    }).run(request);
    const replay = await new AgenticDriver({
      operations: new FileOperationStore(dir),
      providers: [adapter],
    }).run(request);
    assert.deepEqual(replay, first);
    assert.equal(calls, 1);
    if (process.platform !== "win32")
      assert.equal(
        (
          await stat(
            join(dir, operationKey("local", request.idempotencyKey) + ".json"),
          )
        ).mode & 0o777,
        0o600,
      );
    const stores = [new FileOperationStore(dir), new FileOperationStore(dir)];
    const claims = await Promise.all(
      stores.map((store, i) =>
        store.claim("alice", "race", newOperation(request, `run-${i}`)),
      ),
    );
    assert.equal(claims.filter((claim) => claim.created).length, 1);
    assert.equal(claims[0]!.record.runId, claims[1]!.record.runId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("full and corrupted stores fail closed without evicting accepted keys", async () => {
  let calls = 0;
  const driver = new AgenticDriver({
    operations: new MemoryOperationStore({ maxEntries: 1 }),
    providers: [
      mockProvider(() => {
        calls++;
        return { text: "done" };
      }),
    ],
  });
  const result = await driver.run(request);
  await assert.rejects(driver.run({ ...request, idempotencyKey: "second" }), {
    code: "OPERATION_STORE_FULL",
  });
  assert.deepEqual(await driver.run(request), result);
  assert.equal(calls, 1);
  const dir = await mkdtemp(join(tmpdir(), "agenticdriver-corrupt-"));
  try {
    await writeFile(
      join(dir, operationKey("local", request.idempotencyKey) + ".json"),
      "{partial",
    );
    await assert.rejects(
      new AgenticDriver({
        operations: new FileOperationStore(dir),
        providers: [
          mockProvider(() => {
            assert.fail("Corrupt records must not execute");
          }),
        ],
      }).run(request),
      { code: "OPERATION_STORE_ERROR" },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("storage failure before or after a tool effect leaves a replay barrier", async () => {
  for (const failAt of ["tool.called", "tool.completed"] as const) {
    const storage = new MemoryOperationStore();
    let effects = 0,
      calls = 0;
    const broken: OperationStore = {
      async claim(...args) {
        const claim = await storage.claim(...args);
        if (!claim.created) return claim;
        return {
          ...claim,
          writer: {
            ...claim.writer,
            async append(event) {
              if (event.type === failAt)
                throw new Error("private storage credentials");
              await claim.writer.append(event);
            },
          },
        };
      },
    };
    const driver = new AgenticDriver({
      operations: broken,
      providers: [
        mockProvider(() => {
          calls++;
          return {
            text: "",
            toolCalls: [{ id: "effect", name: "write", arguments: {} }],
          };
        }),
      ],
      tools: [
        writeTool(() => {
          effects++;
          return { saved: true };
        }),
      ],
    });
    await assert.rejects(driver.run({ ...request, tools: ["write"] }), {
      code: "OPERATION_STORE_ERROR",
    });
    await assert.rejects(driver.run({ ...request, tools: ["write"] }), {
      code: "OPERATION_UNCERTAIN",
    });
    assert.equal(effects, failAt === "tool.called" ? 0 : 1);
    assert.equal(calls, 1);
  }
});

test("breaking after a confirmed tool effect replays its recorded output with explicit uncertainty", async () => {
  let effects = 0,
    calls = 0;
  const driver = new AgenticDriver({
    operations: new MemoryOperationStore(),
    providers: [
      mockProvider((_input, context) => {
        calls++;
        if (calls === 1)
          return {
            text: "",
            toolCalls: [{ id: "effect", name: "write", arguments: {} }],
          };
        context.emitText("partial");
        return new Promise(() => {});
      }),
    ],
    tools: [
      writeTool(() => {
        effects++;
        return { saved: true };
      }),
    ],
  });
  const input = { ...request, tools: ["write"] };
  for await (const event of driver.stream(input))
    if (event.type === "text.delta") break;
  const replay: RunEvent[] = [];
  for await (const event of driver.stream(input)) replay.push(event);
  assert.deepEqual(
    replay.find((event) => event.type === "tool.completed")?.output,
    { saved: true },
  );
  const last = replay.at(-1)!;
  assert.equal(last.type, "run.failed");
  if (last.type === "run.failed")
    assert.equal(last.error.code, "OPERATION_UNCERTAIN");
  assert.equal(effects, 1);
  assert.equal(calls, 2);
  assert.deepEqual(
    replay.map((event) => event.sequence),
    replay.map((_, index) => index + 1),
  );
});

test("an invoked tool with an unconfirmed outcome reports uncertainty even without an operation store", async () => {
  let effects = 0;
  const driver = new AgenticDriver({
    providers: [
      mockProvider(() => ({
        text: "",
        toolCalls: [{ id: "effect", name: "write", arguments: {} }],
      })),
    ],
    tools: [
      writeTool(() => {
        effects++;
        throw new Error("Effect happened before connection loss");
      }),
    ],
  });
  await assert.rejects(
    driver.run({
      provider: "mock",
      model: "demo",
      input: "hello",
      tools: ["write"],
    }),
    { code: "TOOL_OUTCOME_UNCERTAIN" },
  );
  assert.equal(effects, 1);
});

test("a remote disconnect after a tool effect retains its output for recovery", async () => {
  let effects = 0,
    calls = 0,
    cancelled!: () => void;
  const stopped = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  const driver = new AgenticDriver({
    operations: new MemoryOperationStore(),
    providers: [
      mockProvider((_input, context) => {
        calls++;
        if (calls === 1)
          return {
            text: "",
            toolCalls: [{ id: "effect", name: "write", arguments: {} }],
          };
        context.emitText("partial");
        return new Promise(() => {});
      }),
    ],
    tools: [
      writeTool(() => {
        effects++;
        return { saved: true };
      }),
    ],
    onUsage: () => {
      cancelled();
    },
  });
  const server = await serve(driver, {
    port: 0,
    tokens: [
      { token, subject: "alice", providers: ["mock"], tools: ["write"] },
    ],
  });
  try {
    const client = new AgenticClient({ url: server.url, token });
    const input = { ...request, tools: ["write"] };
    for await (const event of client.stream(input))
      if (event.type === "text.delta") break;
    await stopped;
    const replay: RunEvent[] = [];
    for await (const event of client.stream(input)) replay.push(event);
    assert.deepEqual(
      replay.find((event) => event.type === "tool.completed")?.output,
      { saved: true },
    );
    assert(["run.cancelled", "run.failed"].includes(replay.at(-1)!.type));
    assert.equal(effects, 1);
    assert.equal(calls, 2);
  } finally {
    await server.close();
  }
});

test("a recovery-record size limit never permits another invocation of an accepted tool", async () => {
  let effects = 0;
  const driver = new AgenticDriver({
    operations: new MemoryOperationStore({ maxRecordBytes: 2000 }),
    providers: [
      mockProvider(() => ({
        text: "",
        toolCalls: [{ id: "effect", name: "write", arguments: {} }],
      })),
    ],
    tools: [
      writeTool(() => {
        effects++;
        return { output: "x".repeat(4000) };
      }),
    ],
  });
  const input = { ...request, tools: ["write"] };
  await assert.rejects(driver.run(input), {
    code: "OPERATION_RECORD_LIMIT",
    outcome: "uncertain",
  });
  await assert.rejects(driver.run(input), { code: "OPERATION_UNCERTAIN" });
  assert.equal(effects, 1);
});

test(
  "a process killed after an external effect cannot re-execute the accepted key after restart",
  { skip: process.platform === "win32" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenticdriver-crash-"));
    const storeDir = join(dir, "records"),
      effect = join(dir, "effect.txt"),
      script = join(dir, "child.mjs");
    const input = { ...request, tools: ["write"] };
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await writeFile(
        script,
        `import { AgenticDriver } from ${JSON.stringify(new URL("../src/driver.ts", import.meta.url).href)};
import { FileOperationStore } from ${JSON.stringify(new URL("../src/operations.ts", import.meta.url).href)};
import { mockProvider } from ${JSON.stringify(new URL("../src/providers/mock.ts", import.meta.url).href)};
import { writeFileSync } from 'node:fs';
const keepAlive=setInterval(()=>{},1000);
const driver=new AgenticDriver({operations:new FileOperationStore(${JSON.stringify(storeDir)}),providers:[mockProvider(()=>({text:'',toolCalls:[{id:'effect',name:'write',arguments:{}}]}))],tools:[{name:'write',description:'effect',inputSchema:{type:'object'},execute(){writeFileSync(${JSON.stringify(effect)},'once');process.stdout.write('effect\\n');return new Promise(()=>{});}}]});
await driver.run(${JSON.stringify(input)});
clearInterval(keepAlive);
`,
      );
      child = spawn(process.execPath, ["--import", "tsx", script], {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: new URL("..", import.meta.url),
      });
      const closed = once(child, "close");
      const data = await once(child.stdout!, "data", {
        signal: AbortSignal.timeout(10_000),
      });
      assert.match(String(data[0]), /effect/);
      child.kill("SIGKILL");
      await closed;
      const driver = new AgenticDriver({
        operations: new FileOperationStore(storeDir),
        providers: [
          mockProvider(() => {
            assert.fail("Accepted operations must never restart");
          }),
        ],
        tools: [
          writeTool(() => {
            assert.fail("External effects must never restart");
          }),
        ],
      });
      await assert.rejects(driver.run(input), { code: "OPERATION_UNCERTAIN" });
      assert.equal(await readFile(effect, "utf8"), "once");
    } finally {
      child?.kill("SIGKILL");
      await rm(dir, { recursive: true, force: true });
    }
  },
);
