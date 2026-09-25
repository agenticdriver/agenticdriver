// Synthetic process protocol only. Never talks to a provider or reads credentials.
const fs = require("node:fs");
const readline = require("node:readline");
const path = require("node:path");
const args = process.argv.slice(2);
const account = process.env.CODEX_HOME || "";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
if (args.includes("--version")) {
  console.log(
    account.endsWith("old") ? "codex-cli 0.158.0" : "codex-cli 0.157.0",
  );
} else if (args[0] === "app-server") {
  fs.writeFileSync(path.join(account, "invoked"), "started");
  const starts = path.join(account, "starts");
  fs.appendFileSync(starts, "started\n");
  if (
    account.endsWith("bootstrap-always") ||
    (account.endsWith("bootstrap-once") &&
      fs.readFileSync(starts, "utf8").trim().split("\n").length === 1)
  ) {
    process.stderr.write(
      "Fixture warning\nError: application network permission was revoked\n",
    );
    process.exit(1);
  }
  let thread;
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    const { method, params, id } = message;
    if (id === undefined) return;
    if (method === "initialize") send({ id, result: {} });
    else if (method === "config/read")
      send({
        id,
        result: {
          config: {
            mcp_servers: {
              [account.endsWith("ambiguous-mcp")
                ? "ambient.with.dots"
                : "ambient"]: { command: "must-not-start" },
            },
          },
        },
      });
    else if (method === "thread/start") {
      thread = params;
      fs.writeFileSync(path.join(account, "thread-started"), "started");
      send({ id, result: { thread: { id: "fixture-thread" } } });
    } else if (method === "turn/start") {
      const input = params.input[0].text;
      let channel, value;
      try {
        [channel, value] = JSON.parse(input.slice(input.indexOf("user: ") + 6));
      } catch {}
      if (channel === "stderr") {
        process.stderr.write("Fixture warning\nError: " + value + "\n");
        process.exitCode = 1;
        process.stdin.destroy();
        return;
      }
      send({ id, result: { turn: { id: "fixture-turn" } } });
      const event = (method, extra) =>
        send({
          method,
          params: {
            threadId: "fixture-thread",
            turnId: "fixture-turn",
            ...extra,
          },
        });
      if (channel === "error")
        return event("error", { error: { message: value }, willRetry: false });
      if (channel === "turn.failed")
        return event("turn/completed", {
          turn: {
            id: "fixture-turn",
            status: "failed",
            error: { message: value },
          },
        });
      if (channel === "request")
        return send({ id: "server-request", method: value, params: {} });
      if (channel === "item")
        return event("item/started", {
          item: { id: "operation", type: value },
        });
      if (channel === "wrong-thread")
        return event("item/completed", {
          threadId: "another-thread",
          item: { id: "answer", type: "agentMessage", text: "untrusted" },
        });
      if (channel === "truncated") {
        process.stdin.destroy();
        return;
      }
      if (channel === "cancel") return;
      const text =
        channel === "config"
          ? (params.effort ?? "unset")
          : JSON.stringify({
              input,
              restricted:
                args.includes("--strict-config") &&
                thread.ephemeral === true &&
                thread.sandbox === "read-only" &&
                thread.approvalPolicy === "never" &&
                thread.allowProviderModelFallback === false &&
                thread.environments.length === 0 &&
                params.environments.length === 0 &&
                thread.dynamicTools.length === 0 &&
                thread.selectedCapabilityRoots.length === 0 &&
                thread.config["mcp_servers.ambient.enabled"] === false &&
                args.includes("agents.enabled=false") &&
                args.includes("features.goals=false"),
              account,
              privateCwd: process.cwd() !== account,
              reasoningEffort: params.effort === "medium",
              leakedKey: [
                "OPENAI_API_KEY",
                "ANTHROPIC_API_KEY",
                "GEMINI_API_KEY",
                "XAI_API_KEY",
                "AGENTICDRIVER_TOKEN",
                "CODEX_REFRESH_TOKEN_URL_OVERRIDE",
              ].some((key) => key in process.env),
            });
      event("item/agentMessage/delta", { delta: "progress", itemId: "answer" });
      event("item/completed", {
        item: { id: "answer", type: "agentMessage", text },
      });
      event("thread/tokenUsage/updated", {
        tokenUsage: {
          total: {
            inputTokens: 11,
            outputTokens: 5,
            cachedInputTokens: 3,
            reasoningOutputTokens: 2,
          },
        },
      });
      event("turn/completed", {
        turn: { id: "fixture-turn", status: "completed" },
      });
    }
  });
}
