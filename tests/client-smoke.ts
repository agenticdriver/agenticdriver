import assert from "node:assert/strict";
import { AgenticClient } from "../src/client.js";
const client = new AgenticClient({
  url: process.env.AGENTICDRIVER_TEST_URL!,
  token: process.env.AGENTICDRIVER_TEST_TOKEN!,
});
assert.equal((await client.providers())[0]?.id, "mock");
assert.equal((await client.protocol()).version, "1.0");
const request = {
  provider: "mock",
  model: "demo",
  input: "Unicode 🌍 round trip",
  idleTimeoutMs: 10_000,
};
assert.equal((await client.run(request)).text, "AgenticDriver is connected.");
const types = [];
for await (const event of client.stream(request)) types.push(event.type);
assert.equal(types.at(-1), "run.completed");
console.log("TypeScript client: catalog, run, stream passed");
