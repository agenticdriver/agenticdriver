import type { ProviderAdapter } from "../types.js";
import type { ApiProviderOptions } from "./http.js";
import { responsesAdapter } from "./responses.js";

/** OpenAI Responses API with private native continuation. */
export function openai(options: ApiProviderOptions): ProviderAdapter {
  return responsesAdapter(options, {
    vendor: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1/",
    usageStatId: "openai-api",
    functionStrict: false,
  });
}
