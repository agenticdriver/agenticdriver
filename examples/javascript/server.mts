// Offline server-side example. Replace the explicit fixture adapter with your configured provider.
import { AgenticDriver, type RunRequest, type RunResult } from "agenticdriver";
import { mockProvider } from "agenticdriver/providers";

const driver = new AgenticDriver({
  providers: [
    mockProvider(() => ({ text: "Installed TypeScript server is connected." })),
  ],
});
const request: RunRequest = { provider: "mock", model: "demo", input: "Hello" };
const cancellation = new AbortController();
const result: RunResult = await driver.run(request, {
  subject: "example-user",
  signal: cancellation.signal,
});
console.log(result.text);
