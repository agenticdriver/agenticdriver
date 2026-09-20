import { DriverError } from "../errors.js";
import type { ProviderContext } from "../types.js";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid();
  return value as RecordValue;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw invalid();
  return value;
}
function index(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 1024
  )
    throw invalid();
  return value;
}
function invalid() {
  return new DriverError(
    "INVALID_PROVIDER_RESPONSE",
    "The provider stream contained an invalid event.",
  );
}
function incomplete() {
  return new DriverError(
    "INCOMPLETE_STREAM",
    "The provider stream ended before its completion marker.",
  );
}
function failed() {
  return new DriverError(
    "PROVIDER_FAILED",
    "The provider reported a streaming error.",
  );
}

/** The terminal Responses object is authoritative and preserves encrypted reasoning state. */
export async function collectOpenAI(
  events: AsyncIterable<unknown>,
  context: ProviderContext,
): Promise<unknown> {
  for await (const value of events) {
    const event = record(value),
      type = string(event.type);
    if (type === "error" || type === "response.failed") throw failed();
    if (type === "response.output_text.delta")
      context.emitText(string(event.delta));
    else if (
      type.endsWith(".delta") &&
      typeof event.delta === "string" &&
      event.delta.length
    )
      context.reportProgress();
    else if (
      [
        "response.output_item.added",
        "response.output_item.done",
        "response.content_part.added",
        "response.content_part.done",
      ].includes(type)
    )
      context.reportProgress();
    if (type === "response.completed" || type === "response.incomplete")
      return record(event.response);
  }
  throw incomplete();
}

/** Reconstruct full content blocks so thinking signatures and tool inputs survive the next step. */
export async function collectAnthropic(
  events: AsyncIterable<unknown>,
  context: ProviderContext,
): Promise<unknown> {
  let message: RecordValue | undefined,
    stopped = false;
  const blocks: RecordValue[] = [],
    partialInputs = new Map<number, string>(),
    open = new Set<number>();
  for await (const value of events) {
    const event = record(value),
      type = string(event.type);
    if (type === "error") throw failed();
    if (type === "ping") continue;
    if (type === "message_start") {
      if (message) throw invalid();
      message = { ...record(event.message) };
    } else if (type === "content_block_start") {
      if (!message || stopped) throw invalid();
      const i = index(event.index);
      if (i !== blocks.length) throw invalid();
      const block = { ...record(event.content_block) };
      blocks.push(block);
      open.add(i);
      if (block.type === "text" && typeof block.text === "string")
        context.emitText(block.text);
      else context.reportProgress();
    } else if (type === "content_block_delta") {
      const i = index(event.index),
        block = blocks[i],
        delta = record(event.delta);
      if (!block || !open.has(i)) throw invalid();
      if (delta.type === "text_delta") {
        const text = string(delta.text);
        block.text = string(block.text ?? "") + text;
        context.emitText(text);
      } else if (delta.type === "input_json_delta") {
        const text = string(delta.partial_json);
        partialInputs.set(i, (partialInputs.get(i) ?? "") + text);
        if (text) context.reportProgress();
      } else if (
        delta.type === "thinking_delta" ||
        delta.type === "signature_delta"
      ) {
        const key = delta.type === "thinking_delta" ? "thinking" : "signature",
          text = string(delta[key]);
        block[key] = string(block[key] ?? "") + text;
        if (text) context.reportProgress();
      } else if (delta.type === "citations_delta") {
        block.citations = [
          ...(Array.isArray(block.citations) ? block.citations : []),
          delta.citation,
        ];
        context.reportProgress();
      }
    } else if (type === "content_block_stop") {
      const i = index(event.index);
      if (!open.delete(i)) throw invalid();
      if (partialInputs.has(i)) {
        try {
          blocks[i]!.input = JSON.parse(partialInputs.get(i)!) as unknown;
        } catch {
          throw invalid();
        }
      }
      context.reportProgress();
    } else if (type === "message_delta") {
      if (!message || open.size) throw invalid();
      const delta = record(event.delta);
      Object.assign(message, delta);
      if (event.usage)
        message.usage = {
          ...(message.usage ? record(message.usage) : {}),
          ...record(event.usage),
        };
      stopped = typeof delta.stop_reason === "string";
    } else if (type === "message_stop") {
      if (!message || !stopped || open.size) throw incomplete();
      return { ...message, content: blocks };
    }
  }
  throw incomplete();
}

/** Gemini emits GenerateContentResponse chunks; native parts may contain signed function calls. */
export async function collectGemini(
  events: AsyncIterable<unknown>,
  context: ProviderContext,
): Promise<unknown> {
  const parts: RecordValue[] = [];
  let finishReason: string | undefined, usageMetadata: RecordValue | undefined;
  for await (const value of events) {
    const chunk = record(value);
    if (chunk.error) throw failed();
    if (chunk.usageMetadata)
      usageMetadata = { ...usageMetadata, ...record(chunk.usageMetadata) };
    if (chunk.promptFeedback && record(chunk.promptFeedback).blockReason)
      throw failed();
    if (chunk.candidates === undefined) continue;
    if (!Array.isArray(chunk.candidates) || chunk.candidates.length > 1)
      throw invalid();
    if (!chunk.candidates.length) continue;
    const candidate = record(chunk.candidates[0]);
    if (candidate.content) {
      const content = record(candidate.content);
      if (!Array.isArray(content.parts)) throw invalid();
      for (const value of content.parts) {
        const part = record(value);
        parts.push(part);
        if (typeof part.text === "string" && !part.thought)
          context.emitText(part.text);
        else if (part.text || part.functionCall || part.thoughtSignature)
          context.reportProgress();
      }
    }
    if (candidate.finishReason) finishReason = string(candidate.finishReason);
  }
  if (!finishReason) throw incomplete();
  return {
    candidates: [{ content: { role: "model", parts }, finishReason }],
    usageMetadata,
  };
}

/** OpenAI-compatible chat chunks carry partial tool arguments and a separate final usage chunk. */
export async function collectChat(
  events: AsyncIterable<unknown>,
  context: ProviderContext,
): Promise<unknown> {
  const message: RecordValue = { role: "assistant", content: "" };
  const calls: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[] = [];
  let finishReason: string | undefined, usage: RecordValue | undefined;
  for await (const value of events) {
    if (value === "[DONE]") {
      if (!finishReason) throw incomplete();
      if (calls.length) message.tool_calls = calls;
      return { choices: [{ message, finish_reason: finishReason }], usage };
    }
    const chunk = record(value);
    if (chunk.error) throw failed();
    if (chunk.usage) usage = record(chunk.usage);
    if (!Array.isArray(chunk.choices) || chunk.choices.length > 1)
      throw invalid();
    if (!chunk.choices.length) continue;
    const choice = record(chunk.choices[0]),
      delta = record(choice.delta ?? {});
    if (typeof delta.content === "string") {
      message.content = string(message.content) + delta.content;
      context.emitText(delta.content);
    }
    for (const key of ["reasoning_content", "reasoning", "refusal"]) {
      if (typeof delta[key] === "string" && delta[key]) {
        message[key] = string(message[key] ?? "") + delta[key];
        context.reportProgress();
      }
    }
    if (delta.tool_calls !== undefined) {
      if (!Array.isArray(delta.tool_calls)) throw invalid();
      for (const value of delta.tool_calls) {
        const part = record(value),
          i = index(part.index);
        if (i > calls.length || i >= 32) throw invalid();
        const call = (calls[i] ??= {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        });
        if (part.id !== undefined) call.id += string(part.id);
        if (part.function) {
          const fn = record(part.function);
          if (fn.name !== undefined) call.function.name += string(fn.name);
          if (fn.arguments !== undefined)
            call.function.arguments += string(fn.arguments);
        }
        context.reportProgress();
      }
    }
    if (choice.finish_reason) finishReason = string(choice.finish_reason);
  }
  throw incomplete();
}
