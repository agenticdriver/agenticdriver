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
import { collectOpenAI } from "./streams.js";
import { apiInspection } from "./discovery.js";

const wire = z.object({
  status: z.string(),
  incomplete_details: z.object({ reason: z.string() }).nullish(),
  output: z.array(
    z
      .object({
        type: z.string(),
        call_id: z.string().optional(),
        name: z.string().optional(),
        arguments: z.string().optional(),
        content: z
          .array(
            z
              .object({ type: z.string(), text: z.string().optional() })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough(),
  ),
  usage: z
    .object({
      input_tokens: tokenCount,
      output_tokens: tokenCount,
      input_tokens_details: z.object({ cached_tokens: tokenCount }).optional(),
      output_tokens_details: z
        .object({ reasoning_tokens: tokenCount })
        .optional(),
    })
    .nullish(),
});

/** OpenAI Responses API. Native output items preserve reasoning state between tool steps. */
export function openai(options: ApiProviderOptions): ProviderAdapter {
  const post = streamTransport(options, "https://api.openai.com/v1/", "bearer");
  return {
    usageSource: "provider-response",
    info: apiInfo("openai", "OpenAI", options, "openai-api"),
    inspect: apiInspection(options, "https://api.openai.com/v1/", "bearer"),
    async complete(request, context) {
      const input = request.messages.flatMap((message): unknown[] => {
        if (message.role === "tool")
          return [
            {
              type: "function_call_output",
              call_id: message.callId,
              output: message.content,
            },
          ];
        if (message.role === "assistant" && Array.isArray(message.native))
          return message.native;
        return [{ role: message.role, content: message.content }];
      });
      const result = parseWire(
        wire,
        await post(
          "responses",
          {
            model: request.model,
            instructions: request.instructions,
            input,
            store: false,
            stream: true,
            include: ["reasoning.encrypted_content"],
            max_output_tokens: request.maxOutputTokens,
            ...(request.tools.length
              ? {
                  tools: request.tools.map((t) => ({
                    type: "function",
                    name: t.name,
                    description: t.description,
                    parameters: t.inputSchema,
                    strict: false,
                  })),
                }
              : {}),
          },
          context,
          collectOpenAI,
          request.retry,
        ),
      );
      const length =
        result.status === "incomplete" &&
        result.incomplete_details?.reason === "max_output_tokens";
      if (result.status !== "completed" && !length)
        throw new DriverError(
          "PROVIDER_FAILED",
          "OpenAI could not complete the response.",
        );
      if (
        result.output.some((item) =>
          item.content?.some((part) => part.type === "refusal"),
        )
      )
        throw new DriverError(
          "PROVIDER_REFUSAL",
          "The provider declined this request.",
        );
      const toolCalls = result.output
        .filter((item) => item.type === "function_call")
        .map((item) => ({
          id: item.call_id ?? "",
          name: item.name ?? "",
          arguments: toolArguments(item.arguments ?? ""),
        }));
      if (length && toolCalls.length)
        throw new DriverError(
          "TRUNCATED_TOOL_CALL",
          "The provider reached its output limit during a tool call.",
        );
      return {
        text: result.output
          .flatMap((item) => item.content ?? [])
          .filter((part) => part.type === "output_text")
          .map((part) => part.text ?? "")
          .join(""),
        toolCalls,
        native: result.output,
        finishReason: length ? "length" : "stop",
        usage: result.usage
          ? {
              inputTokens: result.usage.input_tokens,
              outputTokens: result.usage.output_tokens,
              cachedInputTokens:
                result.usage.input_tokens_details?.cached_tokens,
              reasoningTokens:
                result.usage.output_tokens_details?.reasoning_tokens,
            }
          : undefined,
      };
    },
  };
}
