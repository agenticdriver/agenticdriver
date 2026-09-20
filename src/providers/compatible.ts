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
import { collectChat } from "./streams.js";
import { apiInspection } from "./discovery.js";

const wire = z.object({
  choices: z.array(
    z.object({
      finish_reason: z.string().nullable(),
      message: z
        .object({
          content: z.string().nullish(),
          refusal: z.string().nullish(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                type: z.literal("function").default("function"),
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .optional(),
        })
        .passthrough(),
    }),
  ),
  usage: z
    .object({
      prompt_tokens: tokenCount,
      completion_tokens: tokenCount,
      prompt_tokens_details: z.object({ cached_tokens: tokenCount }).optional(),
      completion_tokens_details: z
        .object({ reasoning_tokens: tokenCount })
        .optional(),
    })
    .optional(),
});
export function openaiCompatible(
  options: ApiProviderOptions & { baseUrl: string; vendor?: string },
): ProviderAdapter {
  const post = streamTransport(options, options.baseUrl, "bearer");
  const vendor = options.vendor ?? "openai-compatible";
  return {
    info: apiInfo(vendor, "OpenAI-compatible API", options, vendor),
    inspect: apiInspection(options, options.baseUrl, "bearer"),
    async complete(request, context) {
      const messages: unknown[] = request.instructions
        ? [{ role: "system", content: request.instructions }]
        : [];
      for (const message of request.messages) {
        if (message.role === "tool")
          messages.push({
            role: "tool",
            tool_call_id: message.callId,
            content: message.content,
          });
        else if (message.role === "assistant" && message.native)
          messages.push(message.native);
        else messages.push({ role: message.role, content: message.content });
      }
      const result = parseWire(
        wire,
        await post(
          "chat/completions",
          {
            model: request.model,
            stream: true,
            stream_options: { include_usage: true },
            messages,
            max_tokens: request.maxOutputTokens,
            ...(request.tools.length
              ? {
                  tools: request.tools.map((t) => ({
                    type: "function",
                    function: {
                      name: t.name,
                      description: t.description,
                      parameters: t.inputSchema,
                    },
                  })),
                }
              : {}),
          },
          context,
          collectChat,
          request.retry,
        ),
      );
      const choice = result.choices[0];
      if (
        !choice ||
        !["stop", "tool_calls", "length"].includes(choice.finish_reason ?? "")
      )
        throw new DriverError(
          "PROVIDER_FAILED",
          "The provider could not complete the response.",
        );
      if (choice.message.refusal)
        throw new DriverError(
          "PROVIDER_REFUSAL",
          "The provider declined this request.",
        );
      const toolCalls = (choice.message.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: toolArguments(call.function.arguments),
      }));
      if (choice.finish_reason === "length" && toolCalls.length)
        throw new DriverError(
          "TRUNCATED_TOOL_CALL",
          "The provider reached its output limit during a tool call.",
        );
      const u = result.usage;
      return {
        text: choice.message.content ?? "",
        toolCalls,
        native: choice.message,
        finishReason: choice.finish_reason === "length" ? "length" : "stop",
        usage: u
          ? {
              inputTokens: u.prompt_tokens,
              outputTokens: u.completion_tokens,
              cachedInputTokens: u.prompt_tokens_details?.cached_tokens,
              reasoningTokens: u.completion_tokens_details?.reasoning_tokens,
            }
          : undefined,
      };
    },
  };
}
/** Grok API via xAI's supported Chat Completions endpoint. */
export function xai(options: ApiProviderOptions): ProviderAdapter {
  return openaiCompatible({
    ...options,
    id: options.id ?? "xai",
    name: options.name ?? "Grok API",
    vendor: "xai",
    baseUrl: options.baseUrl ?? "https://api.x.ai/v1/",
  });
}
