import { open, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  connectedClient,
  readConnectionProfile,
} from "@agenticdriver/sdk/connections";
import { applicationPrompts } from "./real-application-prompts.mjs";

const { values } = parseArgs({
  options: {
    connection: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    case: { type: "string" },
    receipt: { type: "string" },
    "refresh-during-run": { type: "boolean", default: false },
  },
});
for (const key of ["connection", "provider", "model", "case", "receipt"])
  if (!values[key])
    throw new Error(
      `Provide --${key}; no connection or model is selected automatically.`,
    );
const cases =
  values.case === "all" ? Object.keys(applicationPrompts) : [values.case];
if (cases.some((name) => !Object.hasOwn(applicationPrompts, name)))
  throw new Error("Use --case brandstorm, literature, workspace, or all.");

// Reserve the private receipt before any inference; never overwrite prior evidence.
const file = await open(values.receipt, "wx", 0o600);
const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const receipt = { version: 1, startedAt: new Date().toISOString(), runs: [] };
try {
  const profile = await readConnectionProfile(values.connection);
  const client = await connectedClient(values.connection);
  receipt.sdkVersion = JSON.parse(
    await readFile(
      new URL(
        "../package.json",
        import.meta.resolve("@agenticdriver/sdk/client"),
      ),
      "utf8",
    ),
  ).version;
  receipt.connection = {
    url: profile.url,
    id: profile.id,
    expiresAt: profile.expiresAt,
  };
  const providers = await client.providers({
    refresh: true,
    signal: controller.signal,
  });
  const provider = providers.find((item) => item.id === values.provider);
  if (!provider)
    throw new Error("The selected connection does not expose this provider.");
  if (
    !["api-key", "cli-session"].includes(provider.authMode) ||
    provider.vendor === "mock"
  )
    throw new Error("This example requires a real provider account.");
  if (provider.models && !provider.models.includes(values.model))
    throw new Error("The host does not allow the selected model.");
  if (
    provider.modelCatalog?.source !== "provider" ||
    !provider.modelCatalog.models.includes(values.model)
  )
    throw new Error(
      "The account has not reported the selected model; inspect its catalog first.",
    );
  const account = provider.connection?.account;
  receipt.provider = {
    id: provider.id,
    vendor: provider.vendor,
    authMode: provider.authMode,
    runtime: provider.connection?.runtime,
    account: account && {
      status: account.status,
      method: account.method,
      subscription: account.subscription,
      hasIdentity: Boolean(account.email || account.name),
    },
    health: provider.health,
    catalog: provider.modelCatalog,
    model: values.model,
  };
  for (const name of cases) {
    controller.signal.throwIfAborted();
    const example = applicationPrompts[name];
    const run = {
      name,
      ...example,
      startedAt: new Date().toISOString(),
      events: {},
    };
    receipt.runs.push(run);
    const started = performance.now();
    console.log(`Running ${name} with ${provider.id} / ${values.model}`);
    try {
      for await (const event of client.stream(
        {
          provider: provider.id,
          model: values.model,
          input: example.input,
          retry: { maxAttempts: 1 },
          maxSteps: 1,
          metadata: { example: name, validation: "real-application-prompt" },
        },
        { signal: controller.signal },
      )) {
        run.events[event.type] = (run.events[event.type] ?? 0) + 1;
        if (event.type === "run.started" && values["refresh-during-run"]) {
          const catalog = await client.providers({
            refresh: true,
            signal: controller.signal,
          });
          run.refreshedCatalog = {
            at: new Date().toISOString(),
            counts: Object.fromEntries(
              catalog.map((item) => [
                item.id,
                item.modelCatalog?.models.length ?? null,
              ]),
            ),
          };
        }
        if (event.type === "text.delta" && run.firstTextMs === undefined)
          run.firstTextMs = Math.round(performance.now() - started);
        if (event.type === "run.completed") run.result = event.result;
        if (event.type === "run.failed" || event.type === "run.cancelled") {
          run.error = event.error;
          throw new Error(`The real provider run ended with ${event.type}.`);
        }
      }
      if (!run.result?.text?.trim())
        throw new Error("The real provider did not return a completed answer.");
      if (
        run.result.provider !== provider.id ||
        run.result.model !== values.model
      )
        throw new Error(
          "The result does not match the explicit provider/model selection.",
        );
      console.log(
        JSON.stringify({
          example: name,
          runId: run.result.runId,
          usage: run.result.usage,
        }),
      );
    } finally {
      run.elapsedMs = Math.round(performance.now() - started);
    }
  }
  receipt.status = "completed";
} catch (error) {
  receipt.status = controller.signal.aborted ? "cancelled" : "failed";
  receipt.error = {
    code: error.code ?? "EXAMPLE_FAILED",
    message: error.message,
  };
  console.error(`${receipt.error.code}: ${receipt.error.message}`);
  process.exitCode = 1;
} finally {
  receipt.finishedAt = new Date().toISOString();
  await file.writeFile(JSON.stringify(receipt, null, 2) + "\n");
  await file.close();
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  console.log(
    `Receipt: ${values.receipt}. Review the actual answers; completion alone is not application acceptance.`,
  );
}
