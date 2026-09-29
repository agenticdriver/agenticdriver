import assert from "node:assert/strict";
import test from "node:test";
import { validateSourceCitations } from "../src/citations.js";

test("citation checks require exact manifest IDs and never repair model typos", () => {
  const id =
    "p-a36e34debbe3d02ab2b3d4f09e80063a2b874d1524453e87b0427a7d195c0e35";
  assert.deepEqual(
    validateSourceCitations(
      `Evidence [source:${id}]. Again [source:${id}].`,
      [id],
      { requireCitation: true },
    ),
    [id],
  );
  for (const text of [
    "No citation",
    "[source:unknown]",
    "[source:",
    "[source:]",
    `[source:${id.slice(0, -1)}]`,
    `[source:${id}][source:unknown]`,
  ])
    assert.throws(
      () => validateSourceCitations(text, [id], { requireCitation: true }),
      { code: "INVALID_CITATION" },
    );
  assert.deepEqual(
    validateSourceCitations("A draft without a citation requirement.", []),
    [],
  );
});
