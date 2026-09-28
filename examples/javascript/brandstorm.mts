// Set the explicit real account and model; there is no offline provider.
import { AgenticDriver } from "@agenticdriver/sdk";
import { configuredProvider } from "./config.mts";
import { applicationPrompts } from "./real-application-prompts.mjs";
const { provider, model } = configuredProvider();
const driver = new AgenticDriver({ providers: [provider] });
const result = await driver.run({
  provider: provider.info.id,
  model,
  input: applicationPrompts.brandstorm.input,
  maxSteps: 1,
  retry: { maxAttempts: 1 },
  metadata: { example: "brandstorm" },
});
console.log(result.text);
console.log(
  JSON.stringify({
    provider: result.provider,
    model: result.model,
    usage: result.usage,
  }),
);
