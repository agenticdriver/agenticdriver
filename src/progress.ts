import { abortable, DriverError } from "./errors.js";
import type { DiagnosticScope } from "./diagnostics.js";
import type {
  EventPayload,
  ExecutionContext,
  ProviderContext,
} from "./types.js";

/** Forward callbacks while awaiting a provider/tool, without buffering a whole turn. */
export async function* withProgress<T, E>(
  operation: (context: ProviderContext) => Promise<T> | T,
  context: ExecutionContext,
  phase: "model" | "tool" | "context",
  abort: (error: DriverError) => void,
  event: (payload: EventPayload) => E,
  diagnostic?: DiagnosticScope,
): AsyncGenerator<E, { value: T; streamed: boolean }> {
  const queue: EventPayload[] = [];
  let bytes = 0,
    streamed = false,
    active = true,
    lastProgress = -Infinity;
  let wake: (() => void) | undefined;
  let outcome:
    { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  const enqueue = (payload: EventPayload, size = 0) => {
    if (!active || context.signal.aborted) return;
    bytes += size;
    if (bytes > 2_000_000 || queue.length >= 1024) {
      abort(
        new DriverError(
          "OUTPUT_BUFFER_LIMIT",
          "The consumer is not keeping up with the event stream.",
        ),
      );
      return;
    }
    const previous = queue.at(-1);
    if (payload.type === "text.delta" && previous?.type === "text.delta")
      previous.text += payload.text;
    else queue.push(payload);
    wake?.();
  };
  const reportProgress = () => {
    if (!active || context.signal.aborted) return;
    context.reportProgress();
    diagnostic?.progress();
    // Reset the timer on every real update, but avoid flooding clients with reasoning notices.
    if (Date.now() - lastProgress >= 1000) {
      lastProgress = Date.now();
      enqueue({ type: "run.progress", phase });
    }
  };
  const emitText = (text: string) => {
    if (!text || !active || context.signal.aborted) return;
    context.reportProgress();
    diagnostic?.progress();
    streamed = true;
    enqueue(
      { type: "text.delta", text },
      new TextEncoder().encode(text).byteLength,
    );
  };
  void abortable(
    Promise.resolve().then(() => {
      context.signal.throwIfAborted();
      return operation({ ...context, reportProgress, emitText });
    }),
    context.signal,
  ).then(
    (value) => {
      diagnostic?.end("completed");
      outcome = { ok: true, value };
      active = false;
      context.reportProgress();
      wake?.();
    },
    (error) => {
      diagnostic?.end(context.signal.aborted ? "cancelled" : "failed");
      outcome = { ok: false, error };
      active = false;
      wake?.();
    },
  );
  try {
    while (true) {
      if (queue.length) {
        const payload = queue.shift()!;
        if (payload.type === "text.delta")
          bytes -= new TextEncoder().encode(payload.text).byteLength;
        yield event(payload);
      } else if (outcome) {
        if (!outcome.ok) throw outcome.error;
        return { value: outcome.value, streamed };
      } else
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
    }
  } finally {
    diagnostic?.end("cancelled");
    active = false;
  }
}
