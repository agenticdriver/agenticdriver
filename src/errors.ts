import type { ErrorInfo } from "./types.js";

export class DriverError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly outcome?: "uncertain",
  ) {
    super(message);
    this.name = "DriverError";
  }
  toJSON(): ErrorInfo {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.outcome ? { outcome: this.outcome } : {}),
    };
  }
}

export function publicError(error: unknown, signal?: AbortSignal): DriverError {
  if (signal?.aborted) {
    return signal.reason instanceof DriverError
      ? signal.reason
      : new DriverError("CANCELLED", "The run was cancelled.");
  }
  if (error instanceof DriverError) return error;
  // Provider bodies, child stderr, and thrown tool errors can contain credentials or user data.
  return new DriverError(
    "INTERNAL_ERROR",
    "The operation failed. Inspect the host's private diagnostics.",
  );
}

/** Stop waiting even if an adapter or tool neglects to observe cancellation. */
export function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
