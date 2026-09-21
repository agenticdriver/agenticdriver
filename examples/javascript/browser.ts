import {
  AgenticClient,
  DriverError,
  PROTOCOL_VERSION,
  type ClientOptions,
  type ClientRequestOptions,
  type ProviderInfo,
  type ProtocolInfo,
  type RunRequest,
  type RunResult,
  type RunEvent,
} from "agenticdriver/client";

const form = document.querySelector<HTMLFormElement>("#connection")!;
const output = document.querySelector<HTMLOutputElement>("#status")!;
const start = document.querySelector<HTMLButtonElement>("#start")!;
const stop = document.querySelector<HTMLButtonElement>("#stop")!;
let pending: AbortController | undefined;
const report = (line: string) => {
  output.textContent += line + "\n";
};
stop.addEventListener("click", () => pending?.abort());
window.addEventListener("pagehide", () => pending?.abort());

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (pending) return;
  const fields = new FormData(form);
  const options: ClientOptions = {
    url: String(fields.get("url")),
    token: String(fields.get("token")),
  };
  const request: RunRequest = {
    provider: String(fields.get("provider")),
    model: String(fields.get("model")),
    input: String(fields.get("input")),
  };
  pending = new AbortController();
  const operation: ClientRequestOptions = { signal: pending.signal };
  start.disabled = true;
  stop.disabled = false;
  output.textContent = "";
  try {
    const client = new AgenticClient(options);
    const protocol: ProtocolInfo = await client.protocol(operation);
    if (protocol.version !== PROTOCOL_VERSION)
      throw new Error("Unsupported protocol");
    const providers: ProviderInfo[] = await client.providers({
      ...operation,
      refresh: true,
    });
    const selected = providers.find(
      (provider) => provider.id === request.provider,
    );
    if (!selected)
      throw new Error("This token cannot use the selected provider.");
    report(
      `Connected: ${selected.name} (${selected.id}) · protocol ${protocol.version}`,
    );
    report("Running…");
    const result: RunResult = await client.run(request, operation);
    report(`Run: ${result.text}`);
    const events: AsyncGenerator<RunEvent> = client.stream(request, operation);
    report("Streaming…");
    for await (const message of events) {
      if (message.type === "text.delta") report(message.text);
      if (message.type === "run.failed" || message.type === "run.cancelled")
        throw new DriverError(
          message.error.code,
          message.error.message,
          message.error.retryable,
          message.error.outcome,
        );
    }
    report("Completed.");
  } catch (error) {
    if (operation.signal?.aborted) report("Cancelled.");
    else if (error instanceof DriverError)
      report(`${error.code}: ${error.message}`);
    else
      report(
        "Connection failed. Check the host, certificate, origin policy and connection settings.",
      );
  } finally {
    pending = undefined;
    start.disabled = false;
    stop.disabled = true;
  }
});
