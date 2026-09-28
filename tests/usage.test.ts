import assert from "node:assert/strict";

import test from "node:test";

import { UsageAccumulator } from "../src/usage.js";

test("invalid numbers, overflowing sums and impossible token subsets remain unknown", () => {
  const meter = new UsageAccumulator();
  meter.start();
  assert.deepEqual(
    meter.add({
      inputTokens: 3,
      cachedInputTokens: 4,
      outputTokens: 1.5,
      reasoningTokens: -1,
      costUsd: Infinity,
      apiEquivalentCostUsd: NaN,
    }),
    { inputTokens: 3 },
  );
  meter.start();
  meter.add({
    inputTokens: Number.MAX_SAFE_INTEGER,
    outputTokens: 7,
    reasoningTokens: 2,
    costUsd: 0,
  });
  assert.deepEqual(meter.snapshot().usage, {});
  assert.equal(meter.snapshot().observedUsage.inputTokens, undefined);
  assert.equal(
    meter.snapshot().observedUsage.costUsd,
    0,
    "Explicit reported zero is distinct from unknown",
  );
  const counts = new UsageAccumulator();
  counts.start();
  assert.deepEqual(
    counts.add({
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 5,
      reasoningTokens: 2,
    }),
    {
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 5,
      reasoningTokens: 2,
    },
  );
  assert.equal(
    counts.snapshot().usage.inputTokens,
    10,
    "Cache is a subset, not an extra additive token charge",
  );
});
