import { z } from "zod";
import { DriverError } from "../errors.js";
import type { ProviderAdapter } from "../types.js";
import {
  apiInfo,
  streamTransport,
  parseWire,
  tokenCount,
  toolArguments,
  type ApiProviderOptions,
} from "./http.js";
import { collectAnthropic } from "./streams.js";
import { apiInspection } from "./discovery.js";

const wire = z.object({
  content: z.array(
    z
      .object({
        type: z.string(),
        text: z.string().optional(),
        id: z.string().optional(),
        name: z.string().optional(),
        input: z.unknown().optional(),
      })
      .passthrough(),
  ),
  stop_reason: z.string().nullable(),
  usage: z
    .object({
      input_tokens: tokenCount,
      output_tokens: tokenCount,
      cache_read_input_tokens: tokenCount,
      cache_creation_input_tokens: tokenCount,
    })
    .optional(),
});
export function anthropic(options: ApiProviderOptions): ProviderAdapter {
  const post = streamTransport(
    options,
    "https://api.anthropic.com/v1/",
    "anthropic",
  );
  return {
    info: apiInfo("anthropic", "Claude API", options, "claude"),
    inspect: apiInspection(
      options,
      "https://api.anthropic.com/v1/",
      "anthropic",
    ),
    async complete(request, context) {
      const messages: { role: string; content: unknown[] }[] = [];
      for (const message of request.messages) {
        const role = message.role === "tool" ? "user" : message.role;
        const content =
          message.role === "tool"
            ? [
                {
                  type: "tool_result",
                  tool_use_id: message.callId,
                  content: message.content,
                },
              ]
            : message.role === "assistant" && Array.isArray(message.native)
              ? message.native
              : [{ type: "text", text: message.content }];
        if (messages.at(-1)?.role === role)
          messages.at(-1)!.content.push(...content);
        else messages.push({ role, content });
      }
      const result = parseWire(
        wire,
        await post(
          "messages",
          {
            model: request.model,
            stream: true,
            system: request.instructions || undefined,
            messages,
            max_tokens: request.maxOutputTokens,
            ...(request.tools.length
              ? {
                  tools: request.tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    input_schema: t.inputSchema,
                  })),
                }
              : {}),
          },
          context,
          collectAnthropic,
        ),
      );
      if (
        !["end_turn", "stop_sequence", "tool_use", "max_tokens"].includes(
          result.stop_reason ?? "",
        )
      )
        throw new DriverError(
          "PROVIDER_FAILED",
          "Claude could not complete the response.",
        );
      const toolCalls = result.content
        .filter((part) => part.type === "tool_use")
        .map((part) => ({
          id: part.id ?? "",
          name: part.name ?? "",
          arguments: toolArguments(part.input),
        }));
      if (result.stop_reason === "max_tokens" && toolCalls.length)
        throw new DriverError(
          "TRUNCATED_TOOL_CALL",
          "The provider reached its output limit during a tool call.",
        );
      const usage = result.usage;
      return {
        text: result.content
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join(""),
        toolCalls,
        native: result.content,
        finishReason: result.stop_reason === "max_tokens" ? "length" : "stop",
        usage: usage
          ? {
              inputTokens:
                usage.input_tokens === undefined
                  ? undefined
                  : usage.input_tokens +
                    (usage.cache_read_input_tokens ?? 0) +
                    (usage.cache_creation_input_tokens ?? 0),
              outputTokens: usage.output_tokens,
              cachedInputTokens: usage.cache_read_input_tokens,
            }
          : undefined,
      };
    },
  };
}
