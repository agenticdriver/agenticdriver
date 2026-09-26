import type { ProviderRequest } from "../types.js";

/** Reconstruct application history as model-visible roles and completed calls. */
export function codexHistory(request: ProviderRequest, server?: string) {
  const items: Record<string, unknown>[] = [];
  if (request.instructions)
    items.push({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: request.instructions }],
    });
  const last = request.messages.at(-1);
  const history =
    last?.role === "user" ? request.messages.slice(0, -1) : request.messages;
  for (const message of history) {
    if (message.role === "tool") {
      items.push({
        type: "function_call_output",
        call_id: message.callId,
        output: message.content,
      });
    } else {
      if (message.content)
        items.push({
          type: "message",
          role: message.role,
          content: [
            {
              type: message.role === "assistant" ? "output_text" : "input_text",
              text: message.content,
            },
          ],
        });
      if (message.role === "assistant")
        for (const call of message.toolCalls ?? [])
          items.push({
            type: "function_call",
            call_id: call.id,
            name: `mcp__${server ?? "agenticdriver_history"}__${call.name}`,
            arguments: JSON.stringify(call.arguments),
          });
    }
  }
  return {
    items,
    input:
      last?.role === "user"
        ? last.content
        : "Continue from the completed tool results in this conversation.",
  };
}
