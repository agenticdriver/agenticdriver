// Owned native gate: no provider credential or application callback enters this process.
import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const event = process.argv[2]!;
let output: Record<string, unknown> =
  event === "PreToolUse"
    ? { decision: "deny", reason: "Application execution belongs to the SDK." }
    : event === "PreInvocation" || event === "PostInvocation"
      ? { terminationBehavior: "terminate" }
      : {};
try {
  const config = JSON.parse(readFileSync(process.argv[3]!, "utf8"));
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 2_000_000) throw new Error("input limit");
  }
  const value = JSON.parse(input);
  const phase = readFileSync(config.mode, "utf8").trim();
  const prior = readFileSync(config.audit, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const allow =
    event === "PreInvocation" &&
    phase === "run" &&
    prior.some(
      (entry) => entry.event === "PreInvocation" && entry.phase === "block",
    ) &&
    !prior.some(
      (entry) => entry.event === "PreInvocation" && entry.phase === "run",
    );
  appendFileSync(
    config.audit,
    JSON.stringify({
      nonce: config.nonce,
      event,
      phase,
      conversationId: value.conversationId,
      ...(event === "SessionStart"
        ? {
            version: execFileSync(config.binary, ["--version"], {
              encoding: "utf8",
              timeout: 3000,
            }).trim(),
          }
        : {}),
      invocationNum: value.invocationNum,
      tool: value.toolCall?.name,
    }) + "\n",
  );
  if (allow) output = {};
} catch {
  // An unavailable audit/mode/config never grants permission or starts inference.
}
process.stdout.write(JSON.stringify(output));
