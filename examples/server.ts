import { readFile } from "node:fs/promises";
import { AgenticDriver } from "../src/index.js";
import { serve } from "../src/server.js";
import { jsonlUsageSink } from "../src/usagestat.js";
import { configuredProvider } from "./config.js";

const token = process.env.AGENTICDRIVER_TOKEN;
if (!token)
  throw new Error("Set AGENTICDRIVER_TOKEN to at least 32 random characters.");
const { provider } = configuredProvider();
const certPath = process.env.AGENTICDRIVER_TLS_CERT,
  keyPath = process.env.AGENTICDRIVER_TLS_KEY;
if (Boolean(certPath) !== Boolean(keyPath))
  throw new Error("Set both TLS certificate and key paths.");
const tls =
  certPath && keyPath
    ? { cert: await readFile(certPath), key: await readFile(keyPath) }
    : undefined;
const driver = new AgenticDriver({
  providers: [provider],
  ...(process.env.AGENTICDRIVER_USAGE_LOG
    ? { onUsage: jsonlUsageSink(process.env.AGENTICDRIVER_USAGE_LOG) }
    : {}),
});
const server = await serve(driver, {
  host: process.env.AGENTICDRIVER_HOST ?? "127.0.0.1",
  port: Number(process.env.AGENTICDRIVER_PORT ?? 7433),
  tokens: [
    {
      token,
      subject: process.env.AGENTICDRIVER_SUBJECT ?? "local-user",
      providers: [provider.info.id],
    },
  ],
  ...(tls ? { tls } : {}),
});
console.log(
  JSON.stringify({
    url: server.url,
    provider: provider.info.id,
    mode: provider.info.authMode,
  }),
);
let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  void server.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
