import {
  anthropic,
  claudeCode,
  codex,
  gemini,
  geminiCli,
  mockProvider,
  openai,
  xai,
} from "../src/providers/index.js";
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderTurn,
} from "../src/types.js";

export function configuredProvider(
  demo?: (request: ProviderRequest) => ProviderTurn,
): { provider: ProviderAdapter; model: string } {
  const selected = process.env.AGENTICDRIVER_PROVIDER ?? "mock";
  const model = process.env.AGENTICDRIVER_MODEL;
  if (selected !== "mock" && !model)
    throw new Error(
      "Set AGENTICDRIVER_MODEL to a model available to your account.",
    );
  const key = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`Set ${name} on the execution host.`);
    return value;
  };
  const models = model ? [model] : undefined;
  let provider: ProviderAdapter;
  switch (selected) {
    case "mock":
      provider = mockProvider(demo);
      break;
    case "openai":
      provider = openai({ apiKey: key("OPENAI_API_KEY"), models });
      break;
    case "anthropic":
      provider = anthropic({ apiKey: key("ANTHROPIC_API_KEY"), models });
      break;
    case "gemini":
      provider = gemini({ apiKey: key("GEMINI_API_KEY"), models });
      break;
    case "xai":
      provider = xai({ apiKey: key("XAI_API_KEY"), models });
      break;
    case "codex":
      provider = codex({ models });
      break;
    case "claude-code":
      provider = claudeCode({ models });
      break;
    case "gemini-cli":
      provider = geminiCli({ models });
      break;
    default:
      throw new Error("Unsupported AGENTICDRIVER_PROVIDER.");
  }
  return { provider, model: model ?? "demo" };
}
