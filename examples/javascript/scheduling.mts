/** Credential-free embedded example using only public package exports. */
import assert from "node:assert/strict";
import { AgenticDriver, type ResourceAdmission } from "@agenticdriver/sdk";
import { mockProvider } from "@agenticdriver/sdk/providers";

const authority: ResourceAdmission = {
  unknown: "reject",
  authorize: ({ identity }) =>
    identity.accountId === "demo-account" ? "allow" : "deny",
};
const driver = new AgenticDriver({
  providers: [
    mockProvider(() => ({
      text: "scheduled",
      usage: { inputTokens: 2, outputTokens: 1 },
    })),
  ],
  usage: { hostId: "example-host", accounts: { mock: "demo-account" } },
  scheduling: {
    total: 2,
    perSubject: 1,
    perAccount: 2,
    queue: { total: 8, perSubject: 4 },
  },
  resources: { default: { maxTokens: 10, unknownUsage: "reject" } },
  resourceAdmission: authority,
});

const results = await Promise.all(
  ["alice", "alice", "bob", "bob"].map((subject) =>
    driver.run(
      {
        provider: "mock",
        model: "demo",
        input: "A synthetic scheduling check",
      },
      { subject },
    ),
  ),
);
assert.ok(results.every((result) => result.text === "scheduled"));
assert.deepEqual(driver.scheduler!.stats, { active: 0, queued: 0 });
console.log("Installed scheduling and resource policies passed");
