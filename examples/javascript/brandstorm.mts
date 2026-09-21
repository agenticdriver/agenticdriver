import { AgenticDriver } from "agenticdriver";
import { mockProvider } from "agenticdriver/providers";

// Synthetic recipe: this example never uses an account or external inference.
const model = "demo";

const provider = mockProvider(() => ({
  text: JSON.stringify({
    directions: [
      {
        name: "Mossline",
        idea: "A calm identity inspired by the natural world.",
      },
      {
        name: "Commonlight",
        idea: "An approachable identity about shared progress.",
      },
      {
        name: "Formwell",
        idea: "A practical identity rooted in thoughtful design.",
      },
    ],
  }),
  usage: { inputTokens: 0, outputTokens: 0 },
}));
const driver = new AgenticDriver({ providers: [provider] });
const result = await driver.run({
  provider: provider.info.id,
  model,
  instructions:
    "You are a brand strategist. Suggest three distinct brand directions. These are creative proposals; do not claim trademark or domain availability.",
  input:
    "Create a warm, thoughtful identity for a sustainable homeware studio.",
  outputSchema: {
    type: "object",
    properties: {
      directions: {
        type: "array",
        minItems: 3,
        maxItems: 3,
        items: {
          type: "object",
          properties: { name: { type: "string" }, idea: { type: "string" } },
          required: ["name", "idea"],
          additionalProperties: false,
        },
      },
    },
    required: ["directions"],
    additionalProperties: false,
  },
  metadata: { app: "brandstorm" },
});
console.log(
  provider.info.authMode === "none"
    ? "Offline demo; scripted proposals."
    : `Provider: ${provider.info.name}`,
);
console.log(JSON.stringify(result.output, null, 2));
