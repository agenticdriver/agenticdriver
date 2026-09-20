import { randomUUID } from "node:crypto";
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
import { collectGemini } from "./streams.js";
import { apiInspection } from "./discovery.js";

const wire = z.object({
  candidates: z
    .array(
      z.object({
        finishReason: z.string().optional(),
        content: z
          .object({
            role: z.string().optional(),
            parts: z.array(
              z
                .object({
                  text: z.string().optional(),
                  thought: z.boolean().optional(),
                  functionCall: z
                    .object({
                      id: z.string().optional(),
                      name: z.string(),
                      args: z.unknown(),
                    })
                    .optional(),
                })
                .passthrough(),
            ),
          })
          .optional(),
      }),
    )
    .optional(),
  usageMetadata: z
    .object({
      promptTokenCount: tokenCount,
      candidatesTokenCount: tokenCount,
      cachedContentTokenCount: tokenCount,
      thoughtsTokenCount: tokenCount,
    })
    .optional(),
});
export function gemini(options: ApiProviderOptions): ProviderAdapter {
  const post = streamTransport(
    options,
    "https://generativelanguage.googleapis.com/v1beta/",
    "google",
  );
  return {
    info: apiInfo("gemini", "Gemini API", options, "gemini"),
    inspect: apiInspection(
      options,
      "https://generativelanguage.googleapis.com/v1beta/",
      "google",
    ),
    async complete(request, context) {
      const contents: { role: string; parts: unknown[] }[] = [];
      for (const message of request.messages) {
        const role = message.role === "assistant" ? "model" : "user";
        const parts =
          message.role === "tool"
            ? [
                {
                  functionResponse: {
                    id: message.callId,
                    name: message.name,
                    response: {
                      result: JSON.parse(message.content) as unknown,
                    },
                  },
                },
              ]
            : message.role === "assistant" && Array.isArray(message.native)
              ? message.native
              : [{ text: message.content }];
        if (contents.at(-1)?.role === role)
          contents.at(-1)!.parts.push(...parts);
        else contents.push({ role, parts });
      }
      const result = parseWire(
        wire,
        await post(
          `models/${encodeURIComponent(request.model.replace(/^models\//, ""))}:streamGenerateContent?alt=sse`,
          {
            contents,
            ...(request.instructions
              ? {
                  systemInstruction: {
                    parts: [{ text: request.instructions }],
                  },
                }
              : {}),
            generationConfig: { maxOutputTokens: request.maxOutputTokens },
            ...(request.tools.length
              ? {
                  tools: [
                    {
                      functionDeclarations: request.tools.map((t) => ({
                        name: t.name,
                        description: t.description,
                        parametersJsonSchema: t.inputSchema,
                      })),
                    },
                  ],
                }
              : {}),
          },
          context,
          collectGemini,
        ),
      );
      const candidate = result.candidates?.[0];
      if (
        !candidate?.content ||
        !["STOP", "MAX_TOKENS"].includes(candidate.finishReason ?? "")
      )
        throw new DriverError(
          "PROVIDER_FAILED",
          "Gemini could not complete the response.",
        );
      // Preserve thoughtSignature fields exactly, including function-call IDs when provided.
      const parts = candidate.content.parts;
      const toolCalls = parts
        .filter((p) => p.functionCall)
        .map((p) => ({
          id: p.functionCall!.id ?? randomUUID(),
          name: p.functionCall!.name,
          arguments: toolArguments(p.functionCall!.args),
        }));
      if (candidate.finishReason === "MAX_TOKENS" && toolCalls.length)
        throw new DriverError(
          "TRUNCATED_TOOL_CALL",
          "The provider reached its output limit during a tool call.",
        );
      const u = result.usageMetadata;
      return {
        text: parts
          .filter((p) => !p.thought)
          .map((p) => p.text ?? "")
          .join(""),
        toolCalls,
        native: parts,
        finishReason:
          candidate.finishReason === "MAX_TOKENS" ? "length" : "stop",
        usage: u
          ? {
              inputTokens: u.promptTokenCount,
              outputTokens:
                u.candidatesTokenCount === undefined
                  ? undefined
                  : u.candidatesTokenCount + (u.thoughtsTokenCount ?? 0),
              cachedInputTokens: u.cachedContentTokenCount,
              reasoningTokens: u.thoughtsTokenCount,
            }
          : undefined,
      };
    },
  };
}
