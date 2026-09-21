/** Optional diagnostics use public exports and need no OpenTelemetry dependency. */
import assert from "node:assert/strict";
import { AgenticDriver } from "@agenticdriver/sdk";
import { mockProvider } from "@agenticdriver/sdk/providers";
import {
  Diagnostics,
  type DiagnosticRecord,
} from "@agenticdriver/sdk/diagnostics";
import { openTelemetryExporter } from "@agenticdriver/sdk/opentelemetry";

const records: DiagnosticRecord[] = [];
const diagnostics = new Diagnostics({
  level: "steps",
  correlation: { requestIdMetadataKey: "requestId" },
  exporter: {
    export(batch) {
      records.push(...batch);
    },
  },
});
const driver = new AgenticDriver({
  diagnostics,
  providers: [mockProvider(() => ({ text: "synthetic answer" }))],
});
await driver.run({
  provider: "mock",
  model: "demo",
  input: "private content",
  metadata: { requestId: "68b8fb27-f22f-4d6b-9c53-1bc2ab466321" },
});
await diagnostics.close();
assert.equal(records.length, 1);
assert.equal(records[0]!.kind, "run");
assert.equal(records[0]!.requestId, "68b8fb27-f22f-4d6b-9c53-1bc2ab466321");
assert.equal(JSON.stringify(records).includes("private content"), false);
assert.equal(diagnostics.metrics().runs.completed, 1);
// The optional bridge itself is also importable without installing an OTel SDK.
assert.equal(typeof openTelemetryExporter, "function");
console.log("Installed optional diagnostics and content redaction passed");
