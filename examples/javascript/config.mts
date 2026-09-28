import {
  anthropic,
  claudeCode,
  codex,
  gemini,
  geminiCli,
  openai,
  xai,
} from "@agenticdriver/sdk/providers";
import type { ProviderAdapter } from "@agenticdriver/sdk";

export function configuredProvider(): {
  provider: ProviderAdapter;
  model: string;
} {
  const selected = process.env.AGENTICDRIVER_PROVIDER;
  const model = process.env.AGENTICDRIVER_MODEL;
  const accountId = process.env.AGENTICDRIVER_ACCOUNT_ID;
  if (!selected || !model || !accountId)
    throw new Error(
      "Set AGENTICDRIVER_PROVIDER, AGENTICDRIVER_ACCOUNT_ID and AGENTICDRIVER_MODEL explicitly before running an example.",
    );
  const native = {
    id: accountId,
    binary: process.env.AGENTICDRIVER_BINARY,
    accountDirectory: process.env.AGENTICDRIVER_ACCOUNT_DIRECTORY,
  };
  const key = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`Set ${name} on the execution host.`);
    return value;
  };
  const models = [model];
  let provider: ProviderAdapter;
  switch (selected) {
    case "openai":
      provider = openai({
        id: accountId,
        apiKey: key("OPENAI_API_KEY"),
        models,
      });
      break;
    case "anthropic":
      provider = anthropic({
        id: accountId,
        apiKey: key("ANTHROPIC_API_KEY"),
        models,
      });
      break;
    case "gemini":
      provider = gemini({
        id: accountId,
        apiKey: key("GEMINI_API_KEY"),
        models,
      });
      break;
    case "xai":
      provider = xai({ id: accountId, apiKey: key("XAI_API_KEY"), models });
      break;
    case "codex":
      provider = codex({
        ...native,
        models,
        reasoningEffort: process.env.AGENTICDRIVER_REASONING_EFFORT,
      });
      break;
    case "claude-code":
      provider = claudeCode({ ...native, models });
      break;
    case "gemini-cli":
      provider = geminiCli({ ...native, models });
      break;
    default:
      throw new Error("Unsupported AGENTICDRIVER_PROVIDER.");
  }
  return { provider, model };
}
