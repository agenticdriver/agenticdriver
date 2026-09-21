/** Synthetic subprocess used to verify recovery after an actual worker crash. */
import { appendFile } from "node:fs/promises";
import { AgenticDriver } from "../src/driver.js";
import { JobService, SqliteJobStore } from "../src/jobs.js";
import { mockProvider } from "../src/providers/mock.js";

const store = await SqliteJobStore.open(process.argv[2]!, {
  retentionMs: 60_000,
});
const driver = new AgenticDriver({
  usage: { hostId: "job-host", accounts: { mock: "synthetic" } },
  providers: [
    mockProvider(async (request) => {
      if (!request.tools.length) return { text: "completed before crash" };
      if (!request.messages.some((message) => message.role === "tool"))
        return {
          text: "",
          toolCalls: [{ id: "crash-effect", name: "write", arguments: {} }],
        };
      process.stdout.write("effect-persisted\n");
      return new Promise(() => {});
    }),
  ],
  tools: [
    {
      name: "write",
      description: "Synthetic side effect",
      inputSchema: { type: "object" },
      execute: async () => {
        await appendFile(process.argv[3]!, "one\n");
        return { saved: true };
      },
    },
  ],
});
await JobService.open(driver, {
  store,
  leaseMs: 600,
  pollIntervalMs: 10,
  maxWorkers: 1,
  resolvePrincipal: () => ({
    subject: "alice",
    providers: ["mock"],
    tools: ["write"],
    jobs: ["submit", "read", "cancel"],
  }),
});
// The embedded application's lifetime is independent from the worker's unref'ed timers.
setInterval(() => {}, 60_000);
