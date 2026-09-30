import assert from "node:assert/strict";
import test from "node:test";
import {
  providerSetupSummary,
  connectionSetupSummary,
} from "../src/setup-status.mjs";
import { RequestSchema } from "../src/controller.mjs";

test("setup checks accept only a saved host and an explicit metadata refresh flag", () => {
  assert.deepEqual(
    RequestSchema.parse({ action: "setup-status", hostId: "local" }),
    {
      action: "setup-status",
      hostId: "local",
      refresh: false,
    },
  );
  for (const extra of [
    { token: "private" },
    { path: "/private" },
    { model: "gpt-6-luna" },
    { run: true },
  ]) {
    assert.equal(
      RequestSchema.safeParse({
        action: "setup-status",
        hostId: "local",
        ...extra,
      }).success,
      false,
    );
  }
  assert.equal(
    RequestSchema.safeParse({
      action: "setup-status",
      hostId: "https://example.com",
    }).success,
    false,
  );
});

test("the setup projection drops private extensions and distinguishes configured IDs from discovered models", () => {
  // Pure contract projection: these fields exercise privacy/accounting boundaries, not provider execution.
  const record = {
    id: "local-codex",
    name: "Codex",
    models: ["gpt-6-luna"],
    connection: {
      account: {
        status: "signed-in",
        email: "redaction-probe",
        name: "redaction-probe",
      },
      runtime: { version: "0.157.0", path: "/redaction-probe" },
    },
    health: { status: "ready", checkedAt: "2026-09-30T00:00:00Z" },
    modelCatalog: {
      source: "configured",
      models: ["gpt-6-luna"],
      complete: false,
    },
    secret: "redaction-probe",
  };
  const management = {
    providers: [
      {
        id: record.id,
        name: record.name,
        enabled: false,
        cli: { env: { PRIVATE: "redaction-probe" } },
      },
    ],
    revision: "redaction-probe",
  };
  const before = JSON.stringify({ record, management });
  const result = providerSetupSummary([record], management);
  assert.equal(result.count, 1);
  assert.equal(result.enabled, 0);
  assert.equal(result.signedIn, 1);
  assert.equal(result.reportedModels, 0);
  assert.equal(result.entries[0].reportedModels, undefined);
  assert.equal(JSON.stringify(result).includes("redaction-probe"), false);
  assert.equal(JSON.stringify({ record, management }), before);
});

test("discovered catalog completeness and unknown account status remain independent from enablement", () => {
  const result = providerSetupSummary([
    {
      id: "local-codex",
      name: "Codex",
      modelCatalog: {
        source: "provider",
        models: ["gpt-6-luna"],
        complete: false,
      },
    },
  ]);
  assert.equal(result.scope, "granted");
  assert.equal(result.enabled, undefined);
  assert.equal(result.signedIn, 0);
  assert.equal(result.reportedModels, 1);
  assert.equal(result.entries[0].health, "unknown");
  assert.equal(result.entries[0].catalogComplete, false);
});

test("empty setup is empty and partial activity cannot be presented as a complete zero", () => {
  assert.equal(providerSetupSummary([], { providers: [] }).count, 0);
  assert.deepEqual(
    connectionSetupSummary({ connections: [], invitations: [] }),
    {
      available: true,
      count: 0,
      invitations: 0,
      activeRequests: 0,
      activityComplete: true,
    },
  );
  const result = connectionSetupSummary({
    connections: [
      { activeRequests: 2, grant: { subject: "redaction-probe" } },
      {},
    ],
    invitations: [{}],
  });
  assert.equal(result.count, 2);
  assert.equal(result.activeRequests, 2);
  assert.equal(result.activityComplete, false);
  assert.equal(JSON.stringify(result).includes("redaction-probe"), false);
});
