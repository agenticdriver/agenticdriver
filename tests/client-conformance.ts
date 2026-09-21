import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AgenticClient } from "../src/client.js";
import type { RetrievalRequest } from "../src/retrieval-types.js";
import { DriverError } from "../src/errors.js";

const reference = process.env.AGENTICDRIVER_TEST_REFERENCE_URL!;
const url = process.env.AGENTICDRIVER_TEST_URL!;
const token = process.env.AGENTICDRIVER_TEST_TOKEN!;
const fixtures = JSON.parse(
  await readFile(
    new URL("../protocol/fixtures/conformance.json", import.meta.url),
    "utf8",
  ),
) as {
  cases: {
    id: string;
    expectedError?: string;
    expectTransportError?: boolean;
    cancel?: boolean;
    operation?: string;
    retrieval?: RetrievalRequest;
  }[];
};
const request = { provider: "mock", model: "demo", input: "Hello" };
const failures: string[] = [];
for (const example of fixtures.cases) {
  const client = new AgenticClient({
    url: `${reference}/fixtures/${example.id}`,
    token,
  });
  let failure: unknown;
  try {
    if (example.operation === "providers") await client.providers();
    else if (example.operation === "protocol") await client.protocol();
    else {
      let completed = false,
        cancelled = false;
      for await (const event of client.stream({
        ...request,
        ...(example.retrieval ? { retrieval: example.retrieval } : {}),
      })) {
        if (example.cancel && event.type === "text.delta") {
          cancelled = true;
          break;
        }
        if (event.type === "run.failed" || event.type === "run.cancelled")
          throw new DriverError(
            event.error.code,
            event.error.message,
            event.error.retryable,
          );
        if (event.type === "run.completed") {
          completed = true;
          assert.equal(event.result.text, "Hello 🌍");
        }
      }
      assert.ok(
        example.cancel ? cancelled : completed,
        "Missing expected outcome",
      );
    }
  } catch (error) {
    failure = error;
  }
  if (example.expectedError) {
    if (
      !(failure instanceof DriverError) ||
      failure.code !== example.expectedError
    )
      failures.push(
        `${example.id}: expected ${example.expectedError}, got ${String(failure)}`,
      );
  } else if (example.expectTransportError) {
    if (!failure)
      failures.push(`${example.id}: redirect unexpectedly succeeded`);
  } else if (failure) failures.push(`${example.id}: ${String(failure)}`);
}

const client = new AgenticClient({ url, token });
const estimated = await client.run({ ...request, input: "conformance-cost" });
assert.equal(estimated.usage.apiEquivalentCostUsd, 0.25);
assert.equal(estimated.usage.costUsd, undefined);
await assert.rejects(
  new AgenticClient({ url, token: "wrong-token" }).run(request),
  { code: "UNAUTHORIZED" },
);
assert.deepEqual(
  await new AgenticClient({ url, token: token + "-restricted" }).providers(),
  [],
);
await assert.rejects(
  new AgenticClient({ url, token: token + "-restricted" }).run(request),
  { code: "FORBIDDEN" },
);
await assert.rejects(client.run({ ...request, tools: ["echo"] }), {
  code: "FORBIDDEN",
});
assert.equal(
  (await client.run({ ...request, input: "conformance-quiet" })).text,
  "AgenticDriver is connected.",
);
assert.equal(
  (
    await client.run({
      ...request,
      input: "conformance-progress",
      idleTimeoutMs: 150,
    })
  ).text,
  "AgenticDriver is connected.",
);
await assert.rejects(
  client.run({ ...request, input: "conformance-stall", idleTimeoutMs: 30 }),
  { code: "IDLE_TIMEOUT" },
);
if (url.startsWith("https:"))
  await assert.rejects(
    new AgenticClient({
      url: url.replace("127.0.0.1", "localhost"),
      token,
    }).providers(),
  );
assert.deepEqual(failures, [], "TypeScript conformance failures");
console.log(
  `TypeScript: ${fixtures.cases.length} wire cases, scoped auth, idle progress and TLS checks passed`,
);
