import { parentPort, workerData } from "node:worker_threads";
import { join } from "node:path";

// The parent validates all configuration and supplies a resolved, pinned runtime.
const { options, texts, runtimeUrl } = workerData;
const progress = () => parentPort!.postMessage({ type: "progress" });
let extractor: any;
try {
  const runtime = await import(runtimeUrl);
  runtime.env.allowLocalModels = !options.allowDownload;
  runtime.env.allowRemoteModels = options.allowDownload;
  // Offline loading addresses only this immutable revision's directory. The
  // runtime's unversioned local-model search path is never an alternate source.
  const modelPath = options.allowDownload
    ? options.model
    : join(options.cacheDirectory, options.model, options.revision);
  extractor = await runtime.pipeline("feature-extraction", modelPath, {
    revision: options.revision,
    dtype: options.dtype,
    device: "cpu",
    cache_dir: options.cacheDirectory,
    local_files_only: !options.allowDownload,
    session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
    progress_callback: (event: { status?: string; loaded?: number }) => {
      if (
        event.status === "done" ||
        (event.status === "progress" && typeof event.loaded === "number")
      )
        progress();
    },
  });
  progress();
  let inputTokens = 0;
  // Reject the whole batch before model execution if any input would be truncated.
  for (const text of texts) {
    const encoded = extractor.tokenizer(text, {
      padding: false,
      truncation: false,
    });
    const count = encoded.input_ids.tolist()[0].length;
    if (
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > options.maxTokens
    ) {
      parentPort!.postMessage({
        type: "error",
        code: "EMBEDDING_INPUT_TOO_LONG",
      });
      await extractor.dispose();
      process.exit(0);
    }
    inputTokens += count;
  }
  const vectors = [];
  for (const text of texts) {
    const output = await extractor(text, {
      pooling: options.pooling,
      normalize: true,
      truncation: false,
    });
    vectors.push(output.tolist()[0]);
    progress();
  }
  await extractor.dispose();
  parentPort!.postMessage({ type: "result", vectors, inputTokens });
} catch {
  parentPort!.postMessage({
    type: "error",
    code: extractor ? "EMBEDDING_FAILED" : "EMBEDDING_MODEL_UNAVAILABLE",
  });
}
