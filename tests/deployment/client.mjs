import assert from "node:assert/strict";
import { AgenticClient } from "@agenticdriver/sdk/client";

const client = new AgenticClient({
  url: process.env.AGENTICDRIVER_TEST_URL,
  token: process.env.AGENTICDRIVER_TEST_TOKEN,
});
const request = {
  provider: "fixture",
  model: "fixture-model",
  input: "Deployment check",
};
assert.equal((await client.protocol()).version, "1.0");
assert.equal((await client.providers({ refresh: true }))[0].id, "fixture");
assert.equal((await client.run(request)).text, "Remote deployment works.");
let text = "";
let completed = false;
for await (const event of client.stream(request)) {
  if (event.type === "text.delta") text += event.text;
  if (event.type === "run.completed") completed = true;
}
assert.equal(text, "Remote deployment works.");
assert.ok(completed);
console.log("Installed JavaScript client passed through verified TLS proxy.");
