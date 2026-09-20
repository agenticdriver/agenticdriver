import type {
  ProviderAdapter,
  ProviderContext,
  ProviderRequest,
  ProviderTurn,
} from "../types.js";

/** Deterministic, offline adapter for development. No API keys and no model inference. */
export function mockProvider(
  respond: (
    request: ProviderRequest,
    context: ProviderContext,
  ) => ProviderTurn | Promise<ProviderTurn> = () => ({
    text: "AgenticDriver is connected.",
    usage: { inputTokens: 0, outputTokens: 0 },
  }),
): ProviderAdapter {
  return {
    info: {
      id: "mock",
      name: "Offline demo",
      vendor: "mock",
      authMode: "none",
      models: ["demo"],
      capabilities: { tools: true, textStreaming: false },
    },
    async complete(request, context) {
      return respond(request, context);
    },
  };
}
