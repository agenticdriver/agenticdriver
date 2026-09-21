# JavaScript and TypeScript

Node.js applications can opt into [diagnostics and OpenTelemetry](diagnostics.md)
through separate package entries. The [diagnostics example](../examples/javascript/diagnostics.mts)
is compiled and run against the installed package, with no telemetry SDK required.

Use `agenticdriver/client` in browsers and servers that connect to an execution host. Use the main `agenticdriver` entry on a Node.js 22+ server to embed the runtime. The package is ESM and includes declarations for every public entry; browser code must import the client entry to keep native processes, provider adapters and host configuration out of the bundle.

Optional [detached jobs](jobs.md) add `submitJob`, `readJob`, `cancelJob` and
`jobEvents` to the browser-safe client. `JobService` and `SqliteJobStore` belong
to the Node.js main entry. The installed [jobs example](../examples/javascript/jobs.mts)
submits a synthetic job, reopens its database, and replays its result once.

## Install a built artifact

Package registries are not published yet. From a reviewed SDK checkout, create an archive and install that archive in your application:

```sh
# SDK checkout: npm pack runs the build first.
npm ci
npm pack --pack-destination /path/to/artifacts
# Application:
npm install /path/to/artifacts/agenticdriver-0.1.0.tgz
```

Set `"type": "module"` in the application's `package.json`, or use `.mjs` / `.mts` files. TypeScript servers use `module` and `moduleResolution` set to `NodeNext`; browser bundlers use `module: "ESNext"` and `moduleResolution: "Bundler"`, with DOM libraries. These modes understand the package's explicit export map and declaration entries. See the [TypeScript module reference](https://www.typescriptlang.org/docs/handbook/modules/reference.html#packagejson-exports).

## Connect, discover and run

This example works in an ESM JavaScript application. `driverUrl`, `driverToken`, `providerId`, `modelId` and `prompt` are values supplied by your application's connection and account selection flow.

```js
import { AgenticClient, DriverError } from "agenticdriver/client";

const client = new AgenticClient({ url: driverUrl, token: driverToken });
const controller = new AbortController();
const options = { signal: controller.signal };
const providers = await client.providers({ ...options, refresh: true });
if (!providers.some((provider) => provider.id === providerId)) {
  throw new Error("The selected provider is unavailable to this connection.");
}
try {
  const result = await client.run(
    { provider: providerId, model: modelId, input: prompt },
    options,
  );
  console.log(result.text);
} catch (error) {
  if (controller.signal.aborted) console.log("Cancelled");
  else if (error instanceof DriverError)
    console.error(error.code, error.message);
  else throw error;
}
// Connect the application's Cancel button to controller.abort().
```

`protocol()` discovers the wire version and advertised features. `providers()` returns authorized provider instances, their capabilities, health and model catalog. `refresh: true` asks the host to refresh discovery without generating a model response. Choose an instance and model explicitly; no provider or model is selected on your behalf.

TypeScript users import the same values and types from the client entry:

```ts
import {
  AgenticClient,
  DriverError,
  type ClientOptions,
  type ClientRequestOptions,
  type ProviderListOptions,
  type RunRequest,
  type RunResult,
  type RunEvent,
  type ProviderInfo,
} from "agenticdriver/client";
```

Context, ingestion and retrieval request/result types are also exported there. `ingestContext`, `indexContext`, `searchContext` and `deleteContext` accept the same optional `AbortSignal`. See [ingestion](ingestion.md) and [retrieval](retrieval.md) for source revision and authorization requirements.

## Stream and cancel

Use streaming **instead of** `run()` when displaying incremental output. Calling both methods creates two executions.

```js
const controller = new AbortController();
for await (const event of client.stream(
  { provider: providerId, model: modelId, input: prompt },
  { signal: controller.signal },
)) {
  if (event.type === "text.delta") appendText(event.text);
  if (event.type === "run.progress") showProgress(event.phase);
  if (event.type === "run.completed") saveResult(event.result);
  if (event.type === "run.failed" || event.type === "run.cancelled") {
    showFailure(event.error.code, event.error.message);
  }
}
```

The UI functions above belong to the application. `run()` returns the final result or throws `DriverError` for a host failure. `stream()` yields terminal failure events; malformed frames, incomplete streams and transport failures throw. Fetch aborts retain their native abort error/reason, and network failures retain their native transport error. Inspect your signal for caller cancellation. `retryable` is advisory: the client never reconnects or replays a request automatically. An error with `outcome: "uncertain"` requires application reconciliation before repeating an action.

Aborting the signal cancels pending network reads. Exiting `for await` with `break` closes the iterator and cancels an unfinished run. If managing an iterator manually, call `return()` when abandoning it; abort its signal first if `next()` is waiting for network data. Application callbacks and tool code must also cooperate with cancellation.

There is no default run duration limit or inactivity timeout. Applications may set a positive `idleTimeoutMs` on a request, subject to host policy; real model, tool or context progress resets it. Discovery uses a separate ten-second I/O timeout. See [timeouts](timeouts.md).

## Browser example and boundary

The archive includes [a plain JavaScript client](../examples/javascript/client.mjs), [a TypeScript server](../examples/javascript/server.mts), and [a browser example](../examples/javascript/browser.ts) with [an HTML form](../examples/javascript/index.html). The JavaScript and browser examples demonstrate a run followed by a second streamed request; using a paid provider may charge for both. The server example is an explicit offline mock.

To build the installed browser example with esbuild:

```sh
npm install --save-dev esbuild typescript
npx esbuild node_modules/agenticdriver/examples/javascript/browser.ts --bundle --platform=browser --format=esm --target=es2023 --outfile=public/browser.js
cp node_modules/agenticdriver/examples/javascript/index.html public/index.html
```

Serve `public` using your application's development server. The host must allow that exact origin, and remote hosts require trusted HTTPS. An HTTPS application should connect to an HTTPS host so browser mixed-content policy does not block it. The runtime needs Fetch, Web Streams, `TextDecoder`, `AbortController`, `AbortSignal.any` and `AbortSignal.timeout`; use a browser that provides them. A custom `fetch` implementation can be supplied through `ClientOptions` on a compatible platform. No browser polyfills are installed by the SDK.

Use a scoped **driver token** supplied by your application's connection flow. Never ship a provider API key, CLI account directory or privileged host token to browser code. The example keeps connection settings in the page and sends requests with `credentials: "omit"`; it does not persist tokens. The host authenticates the subject and enforces provider/tool/corpus scopes. Browser pairing and token issuance are separate host/application work.

## Package verification

`npm run test:install` packs the SDK and installs it into a temporary application. It runs the shipped JavaScript and compiled TypeScript examples, checks all export/declaration files, compiles browser types with only DOM libraries, and bundles the browser example using [esbuild's browser platform](https://esbuild.github.io/api/#platform). Checks reject Node imports, host modules, external imports and references back to repository source in the browser artifact. The installed client also exercises typed errors and cancellation against an installed fixture host. Compilers come from development tooling; the code under test resolves exclusively from the installed archive.
