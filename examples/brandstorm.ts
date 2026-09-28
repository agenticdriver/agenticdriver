import { AgenticDriver } from "../src/index.js";
import { configuredProvider } from "./config.js";
import { applicationPrompts } from "./javascript/real-application-prompts.mjs";

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
