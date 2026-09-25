/** Start the optional local UI. Embedding apps use the bridge described in docs/provider-panel.md. */
import { serveProviderPanel } from "@agenticdriver/sdk/panel-server";
const connectionPath = process.env.AGENTICDRIVER_CONNECTION;
if (!connectionPath)
  throw new Error(
    "Set AGENTICDRIVER_CONNECTION to a private connection profile path (it may not exist yet).",
  );
const panel = await serveProviderPanel({ connectionPath });
console.log(`Provider settings: ${panel.launchUrl}`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void panel.close();
  });
