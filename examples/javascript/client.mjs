// Run against an authenticated driver. These are driver credentials, never vendor API keys.
import { AgenticClient, DriverError } from "@agenticdriver/sdk/client";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before running this example.`);
  return value;
};
const client = new AgenticClient({
  url: required("AGENTICDRIVER_URL"),
  token: required("AGENTICDRIVER_TOKEN"),
});
const request = {
  provider: required("AGENTICDRIVER_PROVIDER"),
  model: required("AGENTICDRIVER_MODEL"),
  input: "Explain what the selected context supports.",
};
const cancellation = new AbortController();
const stop = () => cancellation.abort();
process.once("SIGINT", stop);
try {
  const providers = await client.providers({
    refresh: true,
    signal: cancellation.signal,
  });
  if (!providers.some((provider) => provider.id === request.provider))
    throw new Error("The selected provider is unavailable to this token.");
  const result = await client.run(request, { signal: cancellation.signal });
  console.log("Run:", result.text);
  for await (const event of client.stream(request, {
    signal: cancellation.signal,
  })) {
    if (event.type === "text.delta") process.stdout.write(event.text);
    if (event.type === "run.failed" || event.type === "run.cancelled")
      throw new DriverError(
        event.error.code,
        event.error.message,
        event.error.retryable,
        event.error.outcome,
      );
  }
  process.stdout.write("\n");
} catch (error) {
  if (cancellation.signal.aborted) console.log("Cancelled.");
  else if (error instanceof DriverError) {
    console.error(error.code, error.message);
    process.exitCode = 1;
  } else throw error;
} finally {
  process.off("SIGINT", stop);
}
