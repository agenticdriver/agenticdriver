/** Validate the installed package, never aliases to workspace source. Compilers are test tooling. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { CliProcess } from "../tests/cli-helpers.js";
const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

export async function checkJavaScriptPackage(app: string): Promise<void> {
  const installed = join(app, "node_modules/agenticdriver");
  const pkg = JSON.parse(
    await readFile(join(installed, "package.json"), "utf8"),
  );
  for (const [name, entry] of Object.entries(pkg.exports) as [
    string,
    { types: string; import: string },
  ][]) {
    assert.ok(
      entry.types && entry.import,
      `${name} lacks a declaration or ESM entry`,
    );
    for (const path of [entry.types, entry.import]) {
      assert.ok(
        path.startsWith("./dist/"),
        `${name} points outside the built artifact`,
      );
      await readFile(join(installed, path));
    }
  }
  await cp(join(installed, "examples/javascript"), join(app, "examples"), {
    recursive: true,
  });
  const base = {
    target: "ES2023",
    strict: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: false,
    esModuleInterop: true,
    verbatimModuleSyntax: true,
  };
  await writeFile(
    join(app, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  await writeFile(
    join(app, "tsconfig.server.json"),
    JSON.stringify({
      compilerOptions: {
        ...base,
        module: "NodeNext",
        moduleResolution: "NodeNext",
        lib: ["ES2023"],
        types: ["node"],
        outDir: "compiled-server",
      },
      files: [
        "examples/server.mts",
        "examples/scheduling.mts",
        "examples/jobs.mts",
        "examples/provider-extension.mts",
      ],
    }),
  );
  await writeFile(
    join(app, "tsconfig.browser.json"),
    JSON.stringify({
      compilerOptions: {
        ...base,
        module: "ESNext",
        moduleResolution: "Bundler",
        lib: ["ES2023", "DOM", "DOM.Iterable"],
        types: [],
        noEmit: true,
      },
      files: ["examples/browser.ts", "browser-types.ts", "browser-catalog.ts"],
    }),
  );
  await writeFile(
    join(app, "browser-types.ts"),
    `
    import {AgenticClient, DriverError, type ClientOptions, type ClientRequestOptions, type ProviderListOptions, type RunRequest, type RunResult, type RunEvent, type IngestRequest, type IngestResult, type RetrievalSearch, type RetrievalResult, type ContextSource, type ProtocolInfo, type Usage, type ErrorInfo} from "agenticdriver/client";
    const options: ClientOptions = {url:"https://driver.example",token:"app-token"};
    const client = new AgenticClient(options);
    const approval: import("agenticdriver/client").ApprovalDecision = {approvalId:"approval",runId:"run",call:{id:"call",name:"write",arguments:{revision:"r1"}},decision:"approve"};
    export const decide = (): Promise<import("agenticdriver/client").ApprovalResolution> => client.decideApproval(approval,{signal:new AbortController().signal});
    // @ts-expect-error approval identities are authenticated, never supplied in decision bodies
    client.decideApproval({...approval,subject:"forged"});
    const execution: import("agenticdriver/client").ToolExecutionIdentity = {executionId:"execution",runId:"run",callId:"call"};
    const tool: import("agenticdriver/client").ApplicationToolDefinition = {name:"lookup",description:"Search evidence",inputSchema:{type:"object"}};
    export const progress = (): Promise<import("agenticdriver/client").ToolExecutionReceipt> => client.reportToolProgress(execution);
    export const complete = (): Promise<import("agenticdriver/client").ToolExecutionReceipt> => client.completeTool({...execution,output:{passages:[]}});
    // @ts-expect-error executor identities cannot be supplied in result bodies
    client.completeTool({...execution,output:null,subject:"forged"});
    // @ts-expect-error application exception details cannot be transmitted as failures
    client.completeTool({...execution,error:"private exception"});
    void tool;
    const session: import("agenticdriver/client").SessionCreate = {provider:"account",model:"model",mode:"history"};
    export const createSession = (): Promise<import("agenticdriver/client").SessionSnapshot> => client.createSession(session);
    export const readSession = (): Promise<import("agenticdriver/client").SessionSnapshot> => client.readSession({id:"opaque-id"});
    export const deleteSession = (): Promise<import("agenticdriver/client").SessionDeleteResult> => client.deleteSession({id:"opaque-id"});
    // @ts-expect-error provider private state cannot be imported through public history
    client.createSession({...session,history:[{role:"assistant",content:"visible",native:"forged"}]});
    // @ts-expect-error identity comes from host authentication
    client.readSession({id:"opaque-id",subject:"forged"});
    const operation: ClientRequestOptions = {signal:new AbortController().signal};
    const discovery: ProviderListOptions = {...operation,refresh:true};
    const request: RunRequest = {provider:"account",model:"model",input:"Question"};
    const source: ContextSource = {id:"doc",revision:"r1"};
    const ingestion: IngestRequest = {corpus:"library",document:{type:"text",source,mediaType:"text/markdown",text:"Evidence"}};
    const search: RetrievalSearch = {corpus:"library",query:"Question"};
    export const typed = {run: (): Promise<RunResult> => client.run(request,operation), events: (): AsyncGenerator<RunEvent> => client.stream(request,operation), protocol: (): Promise<ProtocolInfo> => client.protocol(operation), providers: () => client.providers(discovery), ingest: (): Promise<IngestResult> => client.ingestContext(ingestion,operation), search: (): Promise<RetrievalResult> => client.searchContext(search,operation)};
    const usage: Usage = {inputTokens:1};
    const error: ErrorInfo = new DriverError("KNOWN_CODE","Message").toJSON();
    // Host identities and secrets are deliberately absent from client call options.
    // @ts-expect-error subjects are authenticated by the host
    client.run(request,{subject:"forged"});
    // @ts-expect-error driver clients cannot receive provider API keys
    new AgenticClient({url:options.url,token:options.token,apiKey:"forged"});
    void usage; void error;
  `,
  );
  await writeFile(
    join(app, "browser-catalog.ts"),
    `
    import {providerPresentation,quotaPresentation,type UsageStatProvider,type UsageStatQuotaIdentity} from "agenticdriver/catalog";
    const metadata:UsageStatProvider={id:"codex",name:"Codex"};
    const card=providerPresentation({id:"personal",name:"Codex",vendor:"openai",authMode:"cli-session",usageStatId:"codex",capabilities:{tools:false,textStreaming:true}},{metadata,account:{id:"account-one",label:"Personal"}});
    const identity:UsageStatQuotaIdentity={hostId:"host",provider:"personal",accountId:"account-one",subject:"user"};
    const quota=quotaPresentation(identity,undefined,{maxAgeMs:300000});
    if(card.icon.kind!=="fallback" || card.accountLabel!=="Personal" || quota.state!=="unavailable") throw new Error("Bundled catalog contract failed");
    console.log("Installed catalog browser bundle passed");
  `,
  );
  for (const config of ["server", "browser"]) {
    const result = await run(
      process.execPath,
      [
        join(root, "node_modules/typescript/bin/tsc"),
        "--project",
        join(app, `tsconfig.${config}.json`),
        "--listFiles",
      ],
      { cwd: app, timeout: 60_000, maxBuffer: 2_000_000 },
    );
    // Only compiler standard libraries may come from the tool checkout.
    for (const path of result.stdout.trim().split("\n")) {
      const local = relative(app, path);
      assert.ok(
        (!local.startsWith("..") && !isAbsolute(local)) ||
          path.startsWith(join(root, "node_modules/typescript/lib/")),
        `Compiler escaped the installed application: ${path}`,
      );
      if (config === "browser")
        assert.ok(
          !path.includes("/@types/node/"),
          "Browser declarations pulled in Node types",
        );
    }
  }
  const browser = await build({
    absWorkingDir: app,
    entryPoints: {
      browser: "examples/browser.ts",
      catalog: "browser-catalog.ts",
    },
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2023",
    outdir: join(app, "www"),
    metafile: true,
    logLevel: "silent",
  });
  const safeModules = new Set([
    "client.js",
    "approval-types.js",
    "tool-types.js",
    "session-types.js",
    "job-types.js",
    "catalog.js",
    "usagestat-types.js",
    "context-types.js",
    "retrieval-types.js",
    "ingestion-types.js",
    "ingestion-metadata.js",
    "types.js",
    "protocol.js",
    "errors.js",
    "security.js",
  ]);
  for (const [path, info] of Object.entries(browser.metafile!.inputs)) {
    const local = relative(app, resolve(app, path));
    assert.ok(
      !local.startsWith("..") && !isAbsolute(local),
      `Bundle escaped the installed application: ${path}`,
    );
    if (path.includes("agenticdriver/dist/"))
      assert.ok(
        safeModules.has(path.split("agenticdriver/dist/")[1]!),
        `Unexpected host module in browser: ${path}`,
      );
    assert.ok(
      info.imports.every(
        (entry) => !entry.path.startsWith("node:") && !entry.external,
      ),
      `Node/external dependency in browser bundle: ${path}`,
    );
  }
  assert.ok(
    Object.keys(browser.metafile!.inputs).some((path) =>
      path.endsWith("agenticdriver/dist/client.js"),
    ),
    "Bundle missed the installed client",
  );
  await cp(join(app, "examples/index.html"), join(app, "www/index.html"));
  await writeFile(
    join(app, "browser-metafile.json"),
    JSON.stringify(browser.metafile, null, 2),
  );
  await writeFile(join(app, "fixture-host.mjs"), hostFixture);
  const host = new CliProcess([join(app, "fixture-host.mjs")], [], {
    cwd: app,
  });
  try {
    const url = await host.listening();
    const environment = {
      ...process.env,
      AGENTICDRIVER_URL: url,
      AGENTICDRIVER_TOKEN: fixtureToken,
      AGENTICDRIVER_PROVIDER: "mock",
      AGENTICDRIVER_MODEL: "demo",
    };
    const javascript = await run(
      process.execPath,
      [join(app, "examples/client.mjs")],
      { cwd: app, env: environment, timeout: 10000 },
    );
    assert.match(
      javascript.stdout,
      /Run: Installed browser client is connected/,
    );
    const server = await run(
      process.execPath,
      [join(app, "compiled-server/server.mjs")],
      { cwd: app, timeout: 10000 },
    );
    assert.match(server.stdout, /Installed TypeScript server is connected/);
    const scheduling = await run(
      process.execPath,
      [join(app, "compiled-server/scheduling.mjs")],
      { cwd: app, timeout: 10000 },
    );
    assert.match(
      scheduling.stdout,
      /Installed scheduling and resource policies passed/,
    );
    const jobs = await run(
      process.execPath,
      [join(app, "compiled-server/jobs.mjs")],
      { cwd: app, timeout: 10000 },
    );
    assert.match(
      jobs.stdout,
      /Installed durable job submit, reopen and replay passed/,
    );
    const extension = await run(
      process.execPath,
      [join(app, "compiled-server/provider-extension.mjs")],
      {
        cwd: app,
        timeout: 20000,
      },
    );
    assert.match(
      extension.stdout,
      /Installed independent extension: six conformance scenarios and scoped HTTP host passed/,
    );
    await writeFile(
      join(app, "contract-check.mjs"),
      `
      import assert from "node:assert/strict";
      import {AgenticClient,DriverError,PROTOCOL_VERSION} from "agenticdriver/client";
      for(const path of ${JSON.stringify(Object.keys(pkg.exports).map((key) => (key === "." ? "agenticdriver" : `agenticdriver/${key.slice(2)}`)))}) await import(path);
      const client = new AgenticClient({url:process.env.AGENTICDRIVER_URL,token:process.env.AGENTICDRIVER_TOKEN});
      assert.equal(PROTOCOL_VERSION,"1.0");
      await assert.rejects(client.run({provider:"forbidden",model:"demo",input:"hello"}),(e)=>e instanceof DriverError && e.code==="UNKNOWN_PROVIDER");
      const abort = new AbortController();
      const stream = client.stream({provider:"mock",model:"demo",input:"wait-for-cancel"},{signal:abort.signal});
      assert.equal((await stream.next()).value.type,"run.started");
      abort.abort();
      await assert.rejects(async()=>{for await(const _event of stream) {}},(e)=>e.name==="AbortError");
      assert.throws(()=>new AgenticClient({url:"not a URL",token:"fixture"}),e=>e instanceof DriverError && e.code==="INSECURE_TRANSPORT");
      const nativeFetch = globalThis.fetch;
      try {
        globalThis.fetch = function(...args) {assert.equal(this,globalThis);return nativeFetch(...args)};
        await new AgenticClient({url:process.env.AGENTICDRIVER_URL,token:process.env.AGENTICDRIVER_TOKEN}).protocol();
        globalThis.fetch = undefined;
        assert.throws(()=>new AgenticClient({url:process.env.AGENTICDRIVER_URL,token:"fixture"}),e=>e instanceof DriverError && e.code==="UNSUPPORTED_ENVIRONMENT");
        await new AgenticClient({url:process.env.AGENTICDRIVER_URL,token:process.env.AGENTICDRIVER_TOKEN,fetch:nativeFetch}).protocol();
      } finally {globalThis.fetch = nativeFetch}
      console.log("Installed exports, DriverError and AbortSignal contract passed");
    `,
    );
    const contract = await run(
      process.execPath,
      [join(app, "contract-check.mjs")],
      { cwd: app, env: environment, timeout: 10000 },
    );
    assert.match(contract.stdout, /contract passed/);
    const catalog = await run(process.execPath, [join(app, "www/catalog.js")], {
      cwd: app,
      timeout: 10000,
    });
    assert.match(catalog.stdout, /Installed catalog browser bundle passed/);
  } finally {
    assert.equal((await host.stop()).code, 0);
  }
  // Optional local browser fixture, containing only synthetic credentials and a packed SDK copy.
  if (process.env.AGENTICDRIVER_PACKAGE_PREVIEW) {
    const destination = resolve(process.env.AGENTICDRIVER_PACKAGE_PREVIEW);
    await mkdir(dirname(destination), { recursive: true });
    await cp(app, destination, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    console.log(
      `Browser fixture ready at ${destination}; run node fixture-host.mjs from that directory.`,
    );
  }
  console.log(
    "Packed SDK: plain JS, strict NodeNext/DOM-only types, browser bundle isolation, public exports and cancellation passed.",
  );
}
const fixtureToken = "sdk-browser-fixture-token-only-no-live-account";
const hostFixture = `
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {AgenticDriver} from "agenticdriver";
import {serve} from "agenticdriver/server";
import {mockProvider} from "agenticdriver/providers";
const metrics={cancelled:0,completed:0};
const pages=createServer(async(req,res)=>{
  if(req.url==="/metrics"){res.setHeader("Content-Type","application/json");res.end(JSON.stringify(metrics));return;}
  const file=req.url==="/"||req.url==="/index.html"?"index.html":req.url==="/browser.js"?"browser.js":null;
  if(!file){res.writeHead(404);res.end();return;}
  res.setHeader("Content-Type",file.endsWith(".js")?"text/javascript":"text/html");
  res.end(await readFile(new URL("./www/"+file,import.meta.url)));
});
await new Promise(resolve=>pages.listen(0,"127.0.0.1",resolve));
const previewUrl="http://127.0.0.1:"+pages.address().port;
const adapter=mockProvider(async(request,context)=>{
  if(request.messages.at(-1)?.content==="wait-for-cancel") return new Promise((resolve,reject)=>context.signal.addEventListener("abort",()=>reject(context.signal.reason),{once:true}));
  context.emitText("Installed browser client ");context.emitText("is connected.");
  return {text:"Installed browser client is connected.",usage:{inputTokens:1,outputTokens:2}};
});
const driver=new AgenticDriver({providers:[adapter],onUsage:record=>{if(record.status==="cancelled")metrics.cancelled++;if(record.status==="completed")metrics.completed++;}});
const host=await serve(driver,{port:0,allowedOrigins:[previewUrl],tokens:[{token:${JSON.stringify(fixtureToken)},subject:"browser-fixture",providers:["mock"]}]});
console.log(JSON.stringify({event:"listening",url:host.url,previewUrl,token:${JSON.stringify(fixtureToken)}}));
let closing=false;
async function close(){if(closing)return;closing=true;await host.close();pages.closeAllConnections();await new Promise(resolve=>pages.close(resolve));process.exit(0);}
process.once("SIGTERM",close);process.once("SIGINT",close);
`;
