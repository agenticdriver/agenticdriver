import assert from "node:assert/strict";
import test from "node:test";
import { openai } from "../src/providers/index.js";

for (const operation of ["completion", "catalog"] as const) {
  test(`${operation} stops waiting for a stalled host credential after cancellation`, async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const resolving = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const provider = openai({
      apiKey: () => {
        entered();
        return new Promise<string>(() => {});
      },
    });
    const pending =
      operation === "catalog"
        ? provider.inspect!({ signal: controller.signal })
        : provider.complete(
            {
              model: "gpt-6-luna",
              messages: [
                {
                  role: "user",
                  content:
                    "Draft a maintenance email from the selected release notes.",
                },
              ],
              tools: [],
              maxOutputTokens: 128,
            },
            {
              runId: "credential-cancellation",
              subject: "credential-test",
              signal: controller.signal,
              emitText() {},
              reportProgress() {},
            },
          );
    await resolving;
    const reason = new Error("credential lookup cancelled");
    controller.abort(reason);
    let timer: ReturnType<typeof setTimeout>;
    try {
      const outcome = await Promise.race([
        pending.then(
          () => "resolved",
          (error: unknown) => error,
        ),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("still waiting"), 100);
        }),
      ]);
      assert.equal(outcome, reason);
    } finally {
      clearTimeout(timer!);
    }
  });
}
