import assert from "node:assert/strict";
import test from "node:test";
import { collectAnthropic } from "../src/providers/streams.js";
import type { ProviderContext } from "../src/types.js";

// Reduced from the real Haiku 4.5 API stream captured on 2026-11-05.
// Empty-argument tools start with input: {} and may emit an empty JSON fragment.
const emptyArgumentEvents = [
  { type: "message_start", message: { content: [] } },
  {
    type: "content_block_start",
    index: 0,
    content_block: {
      type: "tool_use",
      id: "release-notes-call",
      name: "read_release_notes",
      input: {},
      caller: { type: "direct" },
    },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: "" },
  },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" } },
  { type: "message_stop" },
];

async function* events(values: unknown[]) {
  yield* values;
}

function context(): ProviderContext {
  return {
    runId: "parser-regression",
    subject: "parser-regression",
    signal: new AbortController().signal,
    emitText() {},
    reportProgress() {},
  };
}

test("Anthropic preserves empty tool arguments when its JSON delta is empty", async () => {
  const message = await collectAnthropic(
    events(emptyArgumentEvents),
    context(),
  );
  assert.deepEqual(message, {
    content: [emptyArgumentEvents[1]!.content_block],
    stop_reason: "tool_use",
  });
});

test("Anthropic still assembles nonempty JSON fragments and rejects malformed input", async () => {
  const withFragments = (...fragments: string[]) => [
    ...emptyArgumentEvents.slice(0, 2),
    ...fragments.map((partial_json) => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json },
    })),
    ...emptyArgumentEvents.slice(3),
  ];
  const message = await collectAnthropic(
    events(withFragments("", '{"release":', '"rc3"}', "")),
    context(),
  );
  assert.deepEqual(message, {
    content: [
      {
        ...emptyArgumentEvents[1]!.content_block,
        input: { release: "rc3" },
      },
    ],
    stop_reason: "tool_use",
  });
  await assert.rejects(
    collectAnthropic(events(withFragments("", "{", "")), context()),
    { code: "INVALID_PROVIDER_RESPONSE" },
  );
});
