/** Fixture-only compatibility checks for independently packaged adapters. */
import assert from "node:assert/strict";
import { AgenticDriver } from "./driver.js";
import { abortable, DriverError } from "./errors.js";
import type { ProviderAdapter, RunEvent, RunRequest } from "./types.js";

export type ProviderFixtureScenario =
  "text" | "structured" | "tools" | "private-error" | "cancel" | "native";
export interface ProviderConformanceOptions {
  /** Explicit safety label: factories must use synthetic responses, not paid/live accounts. */
  mode: "fixture";
  model: string;
  create(
    scenario: ProviderFixtureScenario,
    context: { signal: AbortSignal },
  ): ProviderAdapter | Promise<ProviderAdapter>;
  /** Bounds this test harness only; never added to application run requests. */
  testTimeoutMs?: number;
}
export interface ProviderConformanceReport {
  contractVersion: "1.0";
  checks: string[];
  skipped: string[];
}

/**
 * Each scenario has a documented synthetic transcript. This does not certify live
 * accounts, upstream billing, OS process isolation or arbitrary extension code.
 */
export async function testProviderConformance(
  options: ProviderConformanceOptions,
): Promise<ProviderConformanceReport> {
  if (
    options.mode !== "fixture" ||
    !Number.isSafeInteger(options.testTimeoutMs ?? 5000) ||
    (options.testTimeoutMs ?? 5000) < 1 ||
    (options.testTimeoutMs ?? 5000) > 2_147_483_647
  )
    throw new DriverError(
      "INVALID_CONFORMANCE_CONFIG",
      "Select fixture mode and a positive test-harness timeout.",
    );
  const report: ProviderConformanceReport = {
    contractVersion: "1.0",
    checks: [],
    skipped: [],
  };
  for (const scenario of [
    "text",
    "structured",
    "tools",
    "private-error",
    "cancel",
    "native",
  ] as const) {
    const cancellation = new AbortController();
    const timer = setTimeout(
      () =>
        cancellation.abort(
          new DriverError(
            "CONFORMANCE_TIMEOUT",
            "The synthetic adapter check did not finish.",
          ),
        ),
      options.testTimeoutMs ?? 5000,
    );
    try {
      const adapter = await abortable(
        Promise.resolve().then(() =>
          options.create(scenario, { signal: cancellation.signal }),
        ),
        cancellation.signal,
      );
      assert.ok(
        adapter.info.models?.includes(options.model),
        "Fixture model must be explicitly enabled",
      );
      if (
        (scenario === "tools" && !adapter.info.capabilities.tools) ||
        (scenario === "native" && !adapter.info.capabilities.nativeContinuation)
      ) {
        report.skipped.push(scenario);
        continue;
      }
      let effects = 0;
      const driver = new AgenticDriver({
        providers: [adapter],
        usage: {
          hostId: "conformance",
          accounts: { [adapter.info.id]: "fixture" },
        },
        sessions: { retentionMs: 60_000 },
        tools: [
          {
            name: "conformance_lookup",
            description: "Synthetic read",
            inputSchema: {
              type: "object",
              required: ["value"],
              properties: { value: { const: 7 } },
              additionalProperties: false,
            },
            execute: () => {
              effects++;
              return { receipt: 7 };
            },
          },
        ],
      });
      const request: RunRequest = {
        provider: adapter.info.id,
        model: options.model,
        input: `conformance:${scenario}`,
      };
      const discovery = await driver.discoverProviders({
        signal: cancellation.signal,
      });
      assert.equal(discovery[0]!.id, adapter.info.id);
      assert.deepEqual(discovery[0]!.models, adapter.info.models);
      if (scenario === "structured")
        request.outputSchema = {
          type: "object",
          required: ["ok"],
          properties: { ok: { const: true } },
          additionalProperties: false,
        };
      if (scenario === "tools") request.tools = ["conformance_lookup"];
      if (scenario === "native") {
        const session = driver.createSession({
          provider: request.provider,
          model: request.model,
          mode: "native",
        });
        request.session = { id: session.session.id, revision: 0 };
        const first = await driver.run(request, {
          signal: cancellation.signal,
        });
        assert.equal(first.text, "first visible reply");
        const second = await driver.run(
          {
            ...request,
            input: "conformance:native-followup",
            session: { ...request.session, revision: 1 },
          },
          { signal: cancellation.signal },
        );
        assert.equal(second.text, "native state received");
        assert.equal(
          JSON.stringify(
            driver.readSession({ id: session.session.id }),
          ).includes("private-state-marker"),
          false,
        );
        assert.equal(
          JSON.stringify([first, second]).includes("private-state-marker"),
          false,
        );
        driver.deleteSession({ id: session.session.id });
        report.checks.push(scenario);
        continue;
      }
      const events: RunEvent[] = [];
      for await (const event of driver.stream(request, {
        signal: cancellation.signal,
      })) {
        events.push(event);
        // The fixture must signal actual readiness, proving cancellation reaches active work.
        if (scenario === "cancel" && event.type === "run.progress")
          cancellation.abort();
      }
      assert.deepEqual(
        events.map((event) => event.sequence),
        events.map((_, i) => i + 1),
      );
      assert.ok(events.every((event) => event.runId === events[0]!.runId));
      const last = events.at(-1)!;
      if (scenario === "cancel") {
        assert.equal(last.type, "run.cancelled");
        if (last.type === "run.cancelled")
          assert.equal(last.error.code, "CANCELLED");
      } else if (scenario === "private-error") {
        assert.equal(last.type, "run.failed");
        assert.equal(
          JSON.stringify(events).includes("conformance-secret-marker"),
          false,
        );
      } else {
        assert.equal(last.type, "run.completed");
        if (last.type !== "run.completed")
          throw new Error("Missing completed fixture result");
        assert.equal(
          last.result.text,
          scenario === "text"
            ? "Hello fixture"
            : scenario === "tools"
              ? "tool receipt: 7"
              : '{"ok":true}',
        );
        if (scenario === "structured")
          assert.deepEqual(last.result.output, { ok: true });
        if (scenario === "tools") assert.equal(effects, 1);
        if (scenario === "text") {
          assert.deepEqual(
            last.result.usage,
            {},
            "Unreported usage must remain unknown",
          );
          assert.equal(
            events
              .filter((event) => event.type === "text.delta")
              .map((event) => (event.type === "text.delta" ? event.text : ""))
              .join(""),
            last.result.text,
          );
        }
      }
      report.checks.push(scenario);
    } finally {
      clearTimeout(timer);
      cancellation.abort();
    }
  }
  return report;
}
