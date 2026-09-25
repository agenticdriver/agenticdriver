import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { AgenticDriver } from "../src/driver.js";
import { claudeCode } from "../src/providers/local-cli.js";

test(
  "Claude metadata preserves aliases and context variants, isolates accounts and rejects authority or malformed replies",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "agenticdriver-claude-catalog-"),
    );
    const binary = join(directory, "claude"),
      log = join(directory, "messages.jsonl");
    try {
      await writeFile(
        binary,
        `#!/usr/bin/env node
const fs = require('node:fs'), readline = require('node:readline'), path = require('node:path');
const mode = path.basename(process.env.CLAUDE_CONFIG_DIR), args = process.argv.slice(2);
const record = value => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({mode,...value})+'\\n');
record({args});
if (args.includes('--help')) console.log('--restricted --safe-mode --strict-mcp-config --tools');
else if (args[0] === 'auth') process.exitCode = mode === 'signed-out' ? 1 : 0;
else if (args.includes('--version')) console.log(mode === 'unqualified' ? '2.1.999 (Claude Code)' : '2.1.282 (Claude Code)');
else {
  for (const flag of ['--restricted','--safe-mode','--strict-mcp-config','--no-session-persistence']) if (!args.includes(flag)) process.exit(9);
  if (args[args.indexOf('--tools')+1] !== '' || args[args.indexOf('--mcp-config')+1] !== '{"mcpServers":{}}') process.exit(9);
  const settings = JSON.parse(args[args.indexOf('--settings')+1]);
  if (settings.fallbackModel.length || settings.switchModelsOnFlag !== false || settings.disableAllHooks !== true) process.exit(9);
  const send = value => console.log(JSON.stringify(value));
  if (args.includes('--input-format')) {
    if (args.includes('--model')) process.exit(9);
    readline.createInterface({input:process.stdin}).on('line', line => {
      const value = JSON.parse(line); record({message:value});
      if (value.type !== 'control_request' || value.request.subtype !== 'initialize') process.exit(9);
      if (mode === 'authority') return send({type:'control_request',request_id:'native',request:{subtype:'can_use_tool',tool_name:'private-tool'}});
      if (mode === 'bad-id') return send({type:'control_response',response:{subtype:'success',request_id:'different',response:{models:[]}}});
      const models = mode === 'malformed' ? [{value:'unsafe model secret'}] : mode === 'capped' ? Array.from({length:1001},(_,i)=>({value:'m'+i})) : [{value:mode+'[1m]',resolvedModel:'canonical-'+mode+'[1m]'}, {value:'canonical-'+mode+'[1m]'}];
      send({type:'system',subtype:'commands_changed',commands:[{secret:'not-public'}]});
      send({type:'control_response',response:{subtype:'success',request_id:value.request_id,response:{models,account:{email:'not-public@example.com'}}}});
    });
  } else {
    process.stdin.resume();process.stdin.on('end',()=>{
      record({generation:true});
      setTimeout(()=>{
        send({type:'assistant',message:{content:[{type:'text',text:'still running'}]}});
        send({type:'result',is_error:false,result:'still running',usage:{input_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:1}});
      },300);
    });
  }
}
`,
        { mode: 0o700 },
      );
      const names = [
        "first",
        "second",
        "signed-out",
        "unqualified",
        "malformed",
        "bad-id",
        "authority",
        "capped",
      ];
      const driver = new AgenticDriver({
        discovery: { minRefreshMs: 0 },
        providers: names.map((id) =>
          claudeCode({
            id,
            binary,
            accountDirectory: join(directory, id),
            models: [`${id}[1m]`],
          }),
        ),
      });
      const results = await driver.discoverProviders();
      for (const name of ["first", "second"]) {
        const provider = results.find((p) => p.id === name)!;
        assert.equal(provider.health?.code, "CLI_CATALOG_AVAILABLE");
        assert.equal(provider.health?.status, "unknown");
        assert.deepEqual(provider.models, [`${name}[1m]`]);
        assert.deepEqual(provider.modelCatalog, {
          source: "provider",
          models: [`${name}[1m]`, `canonical-${name}[1m]`],
          complete: true,
        });
      }
      assert.equal(results[2]!.health?.code, "CLI_AUTH_REQUIRED");
      assert.equal(results[3]!.health?.code, "CLI_SESSION_PRESENT");
      for (const provider of results.slice(4, 7)) {
        assert.equal(provider.health?.code, "INVALID_DISCOVERY_RESPONSE");
        assert.equal(provider.modelCatalog?.complete, false);
      }
      assert.equal(results[7]!.modelCatalog?.complete, false);
      assert.equal(results[7]!.modelCatalog?.models.length, 1000);
      assert.doesNotMatch(
        JSON.stringify(results),
        /not-public|private-tool|unsafe model secret/,
      );
      await assert.rejects(
        driver.run({
          provider: "first",
          model: "canonical-first[1m]",
          input: "Denied before generation",
        }),
        { code: "UNSUPPORTED_MODEL" },
      );
      const read = async () =>
        (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
      assert.equal((await read()).filter((row) => row.generation).length, 0);
      const messages = (await read()).filter((row) => row.message);
      assert.equal(messages.length, 6);
      assert.ok(
        messages.every(
          (row) =>
            row.message.type === "control_request" &&
            row.message.request.subtype === "initialize",
        ),
      );
      assert.ok(
        messages.every(
          (row) => !["signed-out", "unqualified"].includes(row.mode),
        ),
      );
      const running = driver.run({
        provider: "first",
        model: "first[1m]",
        input: "Synthetic fixture",
      });
      for (
        let n = 0;
        n < 100 && !(await read()).some((row) => row.generation);
        n++
      )
        await delay(10);
      assert.ok((await read()).some((row) => row.generation));
      const refreshed = await driver.discoverProviders({ refresh: true });
      assert.equal(refreshed[0]!.modelCatalog?.complete, true);
      assert.equal((await running).text, "still running");
      assert.equal((await read()).filter((row) => row.generation).length, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
