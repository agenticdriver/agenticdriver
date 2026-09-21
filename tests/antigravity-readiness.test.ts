import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectAntigravityStream } from "../scripts/check-antigravity.js";

test("Antigravity readiness never sends a prompt and does not export native content", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agenticdriver-init-fixture-"));
  try {
    const fixture = join(cwd, "native.cjs"),
      receipt = join(cwd, "receipt.json");
    await writeFile(
      fixture,
      `
      const fs = require('node:fs');
      let bytes = 0;
      process.stdin.on('data', b => bytes += b.length);
      process.stdin.on('end', () => { fs.writeFileSync(process.argv[2], JSON.stringify({bytes})); });
      process.stderr.write('private token and account identifier');
      const data = JSON.stringify({event:'init',conversation_id:'private-session',init:{model:'fixture-model',agent:'agenticdriver-readiness',tools:JSON.parse(process.argv[3]),permission_mode:'strict',cwd:'private-path'}}) + '\\n';
      for (const part of Buffer.from(data)) process.stdout.write(Buffer.from([part]));
    `,
    );
    for (const tools of [
      [],
      ["private-tool-name"],
      ["run_command", "write_to_file"],
    ]) {
      const actual = await inspectAntigravityStream({
        binary: process.execPath,
        args: [fixture, receipt, JSON.stringify(tools)],
        env: {},
        model: "fixture-model",
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(
        actual.status,
        tools.length ? "unsupported-tools" : "ready-for-live-check",
      );
      assert.equal(actual.toolCount, tools.length);
      assert.equal(actual.promptSubmitted, false);
      assert.equal(actual.liveCertified, false);
      assert.equal(JSON.stringify(actual).includes("private"), false);
      assert.deepEqual(JSON.parse(await readFile(receipt, "utf8")), {
        bytes: 0,
      });
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Antigravity initialization rejects fallback, malformed output and broad tool inventories", async () => {
  const native = JSON.parse(
    await readFile(
      new URL("./fixtures/antigravity-1.2.7-init.json", import.meta.url),
      "utf8",
    ),
  );
  const empty = {
    event: "init",
    init: {
      model: "fixture-model",
      agent: "agenticdriver-readiness",
      tools: [],
      permission_mode: "strict",
    },
  };
  for (const [payload, expected] of [
    [native, "unsupported-tools"],
    [
      { ...empty, init: { ...empty.init, model: "fallback-model" } },
      "unexpected-selection",
    ],
    [
      { ...empty, init: { ...empty.init, agent: "default" } },
      "unexpected-selection",
    ],
    [
      { ...empty, init: { ...empty.init, permission_mode: "always-proceed" } },
      "unexpected-selection",
    ],
    [{ ...empty, init: { ...empty.init, tools: null } }, "invalid-output"],
    [
      { event: "result", result: { response: "must not infer" } },
      "invalid-output",
    ],
  ] as const) {
    const actual = await inspectAntigravityStream({
      binary: process.execPath,
      args: [
        "-e",
        "process.stdout.write(process.argv[1]+'\\n');process.stdin.resume();",
        JSON.stringify(payload),
      ],
      env: {},
      model: "fixture-model",
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(actual.status, expected);
    assert.equal(actual.promptSubmitted, false);
  }
  for (const code of [
    "process.stdout.write('not JSON\\n')",
    "process.stdout.write('x'.repeat(70000));process.stdin.resume()",
    "process.stdout.write(Buffer.from([255,10]));process.stdin.resume()",
    "process.stdout.write('{');",
  ]) {
    const actual = await inspectAntigravityStream({
      binary: process.execPath,
      args: ["-e", code],
      env: {},
      model: "fixture-model",
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(actual.status, "invalid-output");
  }
});

test("Antigravity no-prompt readiness is abortable and reaps an unresponsive child", async () => {
  const signal = AbortSignal.timeout(100);
  const actual = await inspectAntigravityStream({
    binary: process.execPath,
    args: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    env: {},
    model: "fixture-model",
    signal,
  });
  assert.equal(actual.status, "probe-timeout");
  const controller = new AbortController();
  controller.abort();
  const cancelled = await inspectAntigravityStream({
    binary: process.execPath,
    args: [],
    env: {},
    model: "fixture-model",
    signal: controller.signal,
  });
  assert.equal(cancelled.status, "cancelled");
});
