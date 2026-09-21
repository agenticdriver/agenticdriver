import { readFile } from "node:fs/promises";
import { AgenticClient } from "agenticdriver/client";

const client = new AgenticClient({
  url: process.env.AGENTICDRIVER_URL,
  // The application owns this private file and replaces it when tokens rotate.
  token: async () =>
    (await readFile(process.env.AGENTICDRIVER_TOKEN_FILE, "utf8")).trim(),
});
const result = await client.run({
  provider: process.env.AGENTICDRIVER_PROVIDER,
  model: process.env.AGENTICDRIVER_MODEL,
  input: "Say hello in one sentence.",
});
console.log(result.text);
