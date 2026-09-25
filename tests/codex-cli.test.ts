import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgenticDriver } from "../src/driver.js";
import { codexCliFailure } from "../src/providers/codex-cli-errors.js";
import { codex, normalizeCli } from "../src/providers/local-cli.js";
import { configuredDriver, validateHostConfig } from "../src/host.js";

// Native 0.157.0 diagnostics from synthetic HTTP responses; never account data.
const failures = [
  ...[
    "",
    " because your refresh token has expired",
    " because your refresh token was already used",
    " because your refresh token was revoked",
  ].map(
    (reason) =>
      [
        `Your access token could not be refreshed${reason}. Please log out and sign in again.`,
        "CLI_AUTH_REQUIRED",
      ] as const,
  ),
  [
    "unexpected status 401 Unauthorized: Your authentication token is expired. Please try signing in again. private-marker, url: http://fixture.invalid/v1/responses",
    "CLI_AUTH_REQUIRED",
  ],
  ["exceeded retry limit, last status: 429 Too Many Requests", "RATE_LIMITED"],
  ["unexpected status 429 Too Many Requests: private-marker", "RATE_LIMITED"],
  [
    "unexpected status 404 Not Found: The model fixture-model does not exist. private-marker, url: http://fixture.invalid/v1/responses",
    "UNSUPPORTED_MODEL",
  ],
] as const;

test("Codex native failure codes preserve actionable meaning without diagnostics", () => {
  for (const [message, code] of failures) {
    for (const input of [message, { message }]) {
      const error = codexCliFailure(input)!;
      assert.equal(error.code, code);
      assert.equal(error.retryable, code === "RATE_LIMITED");
      assert.doesNotMatch(
        JSON.stringify(error),
        /private-marker|fixture\.invalid/,
      );
    }
    for (const event of [
      { type: "error", message },
      { type: "turn.failed", error: { message } },
    ]) {
      assert.throws(() => normalizeCli("codex", JSON.stringify(event)), {
        code,
      });
    }
  }
  for (const input of [
    null,
    {},
    { message: 401 },
    "unknown failure containing 401 and private-marker",
    "unknown failure: Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.",
    "Your access token could not be refreshed because the server is unavailable.",
    "unexpected status 404 Not Found: Endpoint does not exist",
    "unexpected status 403 Forbidden: private-marker",
    "unexpected status 503 Service Unavailable: private-marker",
  ])
    assert.equal(codexCliFailure(input), undefined);
  assert.throws(
    () =>
      normalizeCli(
        "codex",
        JSON.stringify({
          type: "turn.failed",
          error: { message: "unknown private-marker" },
        }),
      ),
    { code: "CLI_FAILED", message: "Codex failed to complete the request." },
  );
  assert.throws(
    () =>
      normalizeCli(
        "codex",
        '{"type":"item.completed","item":{"type":"collab_tool_call"}}',
      ),
    { code: "CLI_POLICY_VIOLATION" },
  );
});

test("Codex reasoning effort is validated only for Codex host instances", () => {
  const config = (kind: string, reasoningEffort: string) => ({
    version: 1,
    providers: [{ kind, id: "fixture", models: ["fixture"], reasoningEffort }],
    tokens: [],
  });
  assert.doesNotThrow(() => validateHostConfig(config("codex", "medium")));
  for (const effort of [
    "",
    "medium\nfeatures.hooks=true",
    'medium"',
    "x".repeat(65),
  ]) {
    assert.throws(() => codex({ reasoningEffort: effort }));
    assert.throws(() => validateHostConfig(config("codex", effort)), {
      code: "INVALID_CONFIG",
    });
  }
  for (const kind of ["claude-code", "gemini-cli"])
    assert.throws(() => validateHostConfig(config(kind, "medium")), {
      code: "INVALID_CONFIG",
    });
});

test(
  "Codex subprocess reports native failures before exit handling and rejects unqualified native versions",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "agenticdriver-codex-test-"),
    );
    const binary = join(directory, "codex-fixture");
    const invoked = join(directory, "invoked");
    try {
      await writeFile(
        binary,
        `#!${process.execPath}
require(${JSON.stringify(fileURLToPath(new URL("./fixtures/codex-app-server.cjs", import.meta.url)))});
`,
        { mode: 0o700 },
      );
      const driver = new AgenticDriver({
        providers: [codex({ binary, accountDirectory: directory })],
      });
      for (const [message, expected] of [
        ...failures,
        ["unrecognized private-marker", "CLI_FAILED"],
      ]) {
        for (const channel of ["error", "turn.failed", "stderr"]) {
          await assert.rejects(
            driver.run({
              provider: "codex",
              model: "fixture-model",
              input: JSON.stringify([channel, message]),
            }),
            (error: unknown) => {
              assert.equal((error as { code: string }).code, expected);
              assert.doesNotMatch(
                JSON.stringify(error),
                /private-marker|fixture\.invalid/,
              );
              return true;
            },
          );
        }
      }
      const configured = configuredDriver(
        validateHostConfig({
          version: 1,
          providers: [
            {
              kind: "codex",
              id: "configured",
              models: ["fixture-model"],
              binary,
              accountDirectory: directory,
              reasoningEffort: "medium",
            },
          ],
          tokens: [],
        }),
        join(directory, "host.json"),
      );
      assert.equal(
        (
          await configured.run({
            provider: "configured",
            model: "fixture-model",
            input: JSON.stringify(["config", ""]),
          })
        ).text,
        "medium",
      );
      await rm(invoked);
      for (const missing of ["old"]) {
        const outdated = new AgenticDriver({
          providers: [
            codex({ binary, accountDirectory: join(directory, missing) }),
          ],
        });
        await assert.rejects(
          outdated.run({
            provider: "codex",
            model: "fixture",
            input: "unused",
          }),
          { code: "CLI_UPGRADE_REQUIRED" },
        );
        await assert.rejects(readFile(invoked), { code: "ENOENT" });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Codex rejects native authority requests and invalid stream boundaries",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "agenticdriver-codex-authority-"),
    );
    const binary = join(directory, "codex-fixture");
    try {
      await writeFile(
        binary,
        `#!${process.execPath}\nrequire(${JSON.stringify(fileURLToPath(new URL("./fixtures/codex-app-server.cjs", import.meta.url)))});\n`,
        { mode: 0o700 },
      );
      const driver = new AgenticDriver({
        providers: [codex({ binary, accountDirectory: directory })],
      });
      const cases = [
        ...[
          "item/tool/call",
          "item/tool/requestUserInput",
          "item/commandExecution/requestApproval",
          "item/fileChange/requestApproval",
          "item/permissions/requestApproval",
          "account/chatgptAuthTokens/refresh",
          "mcpServer/elicitation/request",
          "new/unrecognizedAuthority",
        ].map((method) => ["request", method, "CLI_POLICY_VIOLATION"]),
        ...[
          "commandExecution",
          "fileChange",
          "mcpToolCall",
          "collabAgentToolCall",
          "functionCallOutput",
          "unknownFutureTool",
        ].map((type) => ["item", type, "CLI_POLICY_VIOLATION"]),
        ["wrong-thread", "", "INVALID_CLI_OUTPUT"],
        ["truncated", "", "INCOMPLETE_STREAM"],
      ];
      for (const [channel, value, code] of cases) {
        await assert.rejects(
          driver.run({
            provider: "codex",
            model: "fixture",
            input: JSON.stringify([channel, value]),
          }),
          { code },
        );
      }
      const before = (await readFile(join(directory, "starts"), "utf8"))
        .trim()
        .split("\n").length;
      await assert.rejects(
        driver.run({
          provider: "codex",
          model: "fixture",
          input: JSON.stringify([
            "stderr",
            "application network permission was revoked",
          ]),
        }),
        { code: "CLI_POLICY_CHANGED" },
      );
      assert.equal(
        (await readFile(join(directory, "starts"), "utf8")).trim().split("\n")
          .length,
        before + 1,
        "A submitted prompt must never be retried as startup recovery.",
      );
      for (const account of [
        "bootstrap-once",
        "bootstrap-always",
        "ambiguous-mcp",
      ]) {
        const selected = join(directory, account);
        await mkdir(selected);
        const isolated = new AgenticDriver({
          providers: [codex({ binary, accountDirectory: selected })],
        });
        const run = isolated.run({
          provider: "codex",
          model: "fixture",
          input: "Synthetic context",
        });
        if (account === "bootstrap-once") {
          await run;
          assert.equal(
            (await readFile(join(selected, "starts"), "utf8"))
              .trim()
              .split("\n").length,
            2,
          );
        } else {
          await assert.rejects(run, {
            code:
              account === "bootstrap-always"
                ? "CLI_POLICY_CHANGED"
                : "CLI_POLICY_VIOLATION",
          });
          await assert.rejects(readFile(join(selected, "thread-started")), {
            code: "ENOENT",
          });
          assert.equal(
            (await readFile(join(selected, "starts"), "utf8"))
              .trim()
              .split("\n").length,
            account === "bootstrap-always" ? 2 : 1,
          );
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
