import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { geminiCli } from "../src/providers/local-cli.js";
import { geminiCliFailure } from "../src/providers/gemini-cli-errors.js";
import { AgenticDriver } from "../src/driver.js";

test("Gemini failure classification never exposes native account/error details", () => {
  for (const [input, expected] of [
    [
      { reasonCode: "UNSUPPORTED_CLIENT", message: "private-marker" },
      "CLI_AUTH_UNSUPPORTED",
    ],
    [{ type: "TerminalQuotaError", message: "private-marker" }, "RATE_LIMITED"],
    [
      { type: "RetryableQuotaError", message: "private-marker" },
      "RATE_LIMITED",
    ],
    [{ status: 429, message: "private-marker" }, "RATE_LIMITED"],
    [{ status: 401, message: "private-marker" }, "CLI_AUTH_REQUIRED"],
    [
      { type: "FatalAuthenticationError", message: "private-marker" },
      "CLI_AUTH_REQUIRED",
    ],
    [{ message: "invalid_grant private-marker" }, "CLI_AUTH_REQUIRED"],
    [
      { type: "ModelNotFoundError", message: "private-marker" },
      "UNSUPPORTED_MODEL",
    ],
    [
      { type: "FatalCancellationError", message: "private-marker" },
      "CANCELLED",
    ],
  ] as const) {
    const failure = geminiCliFailure(input)!;
    assert.equal(failure.code, expected);
    assert.equal(failure.message.includes("private-marker"), false);
    assert.equal(failure.retryable, expected === "RATE_LIMITED");
  }
  assert.equal(geminiCliFailure("unrecognized private-marker"), undefined);
  assert.equal(
    geminiCliFailure("private-marker", 41)?.code,
    "CLI_AUTH_REQUIRED",
  );
});

// Native executable wrappers need the separate Windows process-isolation work (AD-012).
test(
  "restricted Gemini subprocess normalizes startup and streamed failures before generic exit handling",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "agenticdriver-gemini-fixture-"),
    );
    const binary = join(directory, "gemini-fixture");
    try {
      await writeFile(
        binary,
        `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args.includes('--help')){console.log('--admin-policy --output-format --extensions');process.exit(0)}
const settings=JSON.parse(fs.readFileSync(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH,'utf8'));
const assert=require('node:assert/strict');
assert.deepEqual(settings.tools.core,['__agenticdriver_no_tools__']);
assert.equal(settings.hooksConfig.enabled,false);
assert.equal(settings.experimental.enableAgents,false);
assert.equal(settings.experimental.autoMemory,false);
assert.equal(settings.experimental.modelSteering,false);
assert.equal(settings.skills.enabled,false);
assert.equal(settings.admin.extensions.enabled,false);
assert.equal(settings.admin.mcp.enabled,false);
assert.equal(settings.admin.skills.enabled,false);
assert.equal(process.env.GEMINI_API_KEY,undefined);
assert.equal(args[args.indexOf('--extensions')+1],'none');
assert.match(fs.readFileSync(args[args.indexOf('--admin-policy')+1],'utf8'),/decision = "deny"/);
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
 if(input.includes('unsupported')){process.stderr.write('IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. private-marker');process.exitCode=1}
 else if(input.includes('unauthenticated')){process.stderr.write('private-marker');process.exitCode=41}
 else if(input.includes('expired')){process.stderr.write('Authentication error: invalid_grant private-marker');process.exitCode=1}
 else if(input.includes('quota')){console.log(JSON.stringify({type:'result',status:'error',error:{type:'RetryableQuotaError',message:'private-marker'}}));process.exitCode=1}
 else if(input.includes('unknown')){process.stderr.write('private-marker');process.exitCode=1}
 else{console.log(JSON.stringify({type:'message',role:'assistant',content:'done'}));console.log(JSON.stringify({type:'result',status:'success',stats:{input_tokens:4,output_tokens:2,cached:0,tool_calls:0}}))}
});
`,
        { mode: 0o700 },
      );
      const driver = new AgenticDriver({
        providers: [
          geminiCli({
            binary,
            accountDirectory: directory,
            models: ["fixture-model"],
          }),
        ],
      });
      for (const [input, code] of [
        ["unsupported", "CLI_AUTH_UNSUPPORTED"],
        ["expired", "CLI_AUTH_REQUIRED"],
        ["unauthenticated", "CLI_AUTH_REQUIRED"],
        ["quota", "RATE_LIMITED"],
        ["unknown", "CLI_FAILED"],
      ]) {
        await assert.rejects(
          driver.run({
            provider: "gemini-cli",
            model: "fixture-model",
            input: input!,
          }),
          (error: unknown) => {
            assert.equal((error as { code: string }).code, code);
            assert.equal(
              (error as Error).message.includes("private-marker"),
              false,
            );
            return true;
          },
        );
      }
      const result = await driver.run({
        provider: "gemini-cli",
        model: "fixture-model",
        input: "success",
      });
      assert.equal(result.text, "done");
      assert.equal(result.usage.costUsd, undefined);
      assert.deepEqual(result.usage, {
        inputTokens: 4,
        outputTokens: 2,
        cachedInputTokens: 0,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
