import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataset, scoreScenario } from "../scripts/evaluation-scoring.js";
import { evaluateFixtures, evaluateLive } from "../scripts/evaluation-suite.js";
import { main, LiveConfigurationSchema } from "../scripts/evaluate.js";
import { mockProvider } from "../src/providers/mock.js";

// This watchdog bounds broken test infrastructure, not SDK runs or real evaluation calls.
test(
  "three scenario rubrics separate quality failures from completed local/HTTP runs",
  { timeout: 20_000 },
  async () => {
    const report = await evaluateFixtures();
    assert.equal(
      report.passed,
      true,
      JSON.stringify(report.rows.filter((row) => !row.passed)),
    );
    assert.equal(report.liveModelCalls, 0);
    assert.equal(report.provenance.store, "sqlite-reopened");
    assert.equal(
      report.rows.filter((row) => row.expected === "quality-pass").length,
      6,
    );
    const controls = report.rows.filter(
      (row) => row.expected === "quality-fail",
    );
    assert.equal(controls.length, 16);
    assert.ok(
      controls.every(
        (row) => row.transport === "completed" && row.quality?.passed === false,
      ),
    );
    for (const scenario of dataset.scenarios)
      for (const transport of ["local", "http"]) {
        const rows = report.rows.filter((row) =>
          row.id.startsWith(`${scenario.id}/${transport}/`),
        );
        for (const boundary of [
          "wrong-tenant",
          "ungranted-source",
          "insufficient-evidence",
          "unsupported-capability",
          "hostile-context-effect",
          "cancel-during-tool",
          "revoked-source",
          "stale-index",
          "deleted-source",
        ])
          assert.ok(
            rows.some(
              (row) =>
                row.id.endsWith(`/${boundary}`) &&
                row.transport === "rejected" &&
                row.passed,
            ),
            boundary,
          );
      }
  },
);

test("rubrics reject missing/malformed output and valid-looking citations without actual evidence", () => {
  for (const scenario of dataset.scenarios)
    for (const value of [undefined, null, [], {}, "looks fine"])
      assert.equal(scoreScenario(scenario, value, []).passed, false);
  const paper = dataset.scenarios.find((s) => s.kind === "literature")!;
  assert.equal(scoreScenario(paper, paper.reference, []).passed, false);
});

test("live evaluation requires explicit cost/account/model/version selection before provider use", async () => {
  let calls = 0;
  const provider = mockProvider(() => {
    calls++;
    return { text: "never" };
  });
  for (const selection of [
    {
      model: "",
      accountLabel: "chosen",
      providerVersion: "test",
      acknowledgePaidCalls: true as const,
    },
    {
      model: "demo",
      accountLabel: "",
      providerVersion: "test",
      acknowledgePaidCalls: true as const,
    },
    {
      model: "demo",
      accountLabel: "chosen",
      providerVersion: "",
      acknowledgePaidCalls: true as const,
    },
    {
      model: "demo",
      accountLabel: "chosen",
      providerVersion: "test",
      acknowledgePaidCalls: true as const,
    },
  ])
    await assert.rejects(evaluateLive({ provider, ...selection }));
  assert.equal(calls, 0);
  await assert.rejects(main(["--allow-paid"]));
  await assert.rejects(main(["--live-config", "/unused/private/config.json"]));
  assert.equal(
    LiveConfigurationSchema.safeParse({
      provider: "openai",
      model: "explicit",
      accountLabel: "chosen",
      providerVersion: "v1",
      apiKeyFile: "key",
      baseUrl: "http://fallback.test",
    }).success,
    false,
  );
});

test("live errors stop the suite, retain explicit provenance and never expose provider error text", async () => {
  let calls = 0;
  const mock = mockProvider(() => {
    calls++;
    throw new Error("sensitive-upstream-body");
  });
  const provider = {
    ...mock,
    info: { ...mock.info, authMode: "api-key" as const },
  };
  const report = await evaluateLive({
    provider,
    model: "demo",
    accountLabel: "synthetic",
    providerVersion: "fixture-v1",
    acknowledgePaidCalls: true,
  });
  assert.equal(report.passed, false);
  assert.equal(calls, 1);
  assert.equal(report.rows[0]?.errorCode, "INTERNAL_ERROR");
  assert.equal(report.provenance.providerVersionSource, "caller-reported");
  assert.ok(!JSON.stringify(report).includes("sensitive-upstream-body"));
});

test(
  "CLI writes a private deterministic report and refuses overwrite before any live call",
  { timeout: 20_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ad-evaluation-report-"));
    try {
      const output = join(directory, "report.json");
      assert.equal(await main(["--output", output]), 0);
      const original = await readFile(output, "utf8");
      const report = JSON.parse(original);
      assert.equal(report.mode, "fixture");
      assert.equal(report.passed, true);
      assert.equal(report.liveModelCalls, 0);
      assert.equal(report.rows.length, 76);
      assert.match(report.datasetSha256, /^[a-f0-9]{64}$/);
      if (process.platform !== "win32")
        assert.equal((await stat(output)).mode & 0o077, 0);
      const key = join(directory, "api-key");
      await writeFile(key, "synthetic-key-never-sent", { mode: 0o600 });
      const config = join(directory, "config.json");
      await writeFile(
        config,
        JSON.stringify({
          provider: "openai",
          model: "synthetic-model",
          accountLabel: "synthetic",
          providerVersion: "fixture",
          apiKeyFile: "api-key",
        }),
      );
      await assert.rejects(
        main(["--output", output, "--live-config", config, "--allow-paid"]),
        { code: "EEXIST" },
      );
      assert.equal(await readFile(output, "utf8"), original);
      assert.ok(!original.includes("synthetic-key-never-sent"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
