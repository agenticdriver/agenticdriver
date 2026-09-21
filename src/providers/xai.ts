import type { ProviderAdapter } from "../types.js";
import type { ApiProviderOptions } from "./http.js";
import { responsesAdapter } from "./responses.js";

/** Explicit xAI Responses API; existing xai() Chat Completions behavior stays unchanged. */
export function xaiResponses(options: ApiProviderOptions): ProviderAdapter {
  return responsesAdapter(options, {
    vendor: "xai",
    name: "Grok Responses API",
    baseUrl: "https://api.x.ai/v1/",
    usageStatId: "xai",
    supportsPdf: false,
  });
}
