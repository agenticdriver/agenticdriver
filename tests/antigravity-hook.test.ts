import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(
  new URL("../src/providers/antigravity-hook.ts", import.meta.url),
);
async function gate() {
  const root = await mkdtemp(join(tmpdir(), "antigravity-hook-"));
  const mode = join(root, "mode"),
    audit = join(root, "audit"),
    manifest = join(root, "manifest");
  await writeFile(mode, "block");
  await writeFile(audit, "");
  await writeFile(
    manifest,
    JSON.stringify({
      mode,
      audit,
      nonce: "owned-operation",
      binary: "/not-used-for-tool-gating",
    }),
  );
  return {
    root,
    mode,
    audit,
    manifest,
    invoke(event: string, value: unknown = {}) {
      return JSON.parse(
        execFileSync(
          process.execPath,
          ["--import", "tsx", helper, event, manifest],
          { input: JSON.stringify(value), encoding: "utf8" },
        ),
      );
    },
  };
}

test("owned Antigravity hook denies every native tool namespace and malformed input", async () => {
  const state = await gate();
  try {
    for (const name of [
      "view_file",
      "write_file",
      "run_command",
      "search_web",
      "manage_task",
      "schedule",
      "invoke_subagent",
      "mcp_unknown",
      "future_native_tool",
    ]) {
      assert.equal(
        state.invoke("PreToolUse", { toolCall: { name, args: {} } }).decision,
        "deny",
      );
    }
    await writeFile(state.manifest, "invalid JSON");
    assert.equal(state.invoke("PreToolUse").decision, "deny");
    assert.equal(
      state.invoke("PreInvocation").terminationBehavior,
      "terminate",
    );
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("owned Antigravity hook proves blocked startup then permits only one application invocation", async () => {
  const state = await gate();
  try {
    assert.equal(
      state.invoke("PreInvocation", { invocationNum: 0 }).terminationBehavior,
      "terminate",
    );
    await writeFile(state.mode, "run");
    assert.deepEqual(state.invoke("PreInvocation", { invocationNum: 0 }), {});
    assert.equal(
      state.invoke("PreInvocation", { invocationNum: 1 }).terminationBehavior,
      "terminate",
    );
    assert.equal(
      state.invoke("PostInvocation").terminationBehavior,
      "terminate",
    );
    const records = (await readFile(state.audit, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      records.map(({ event, phase }) => [event, phase]),
      [
        ["PreInvocation", "block"],
        ["PreInvocation", "run"],
        ["PreInvocation", "run"],
        ["PostInvocation", "run"],
      ],
    );
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});
