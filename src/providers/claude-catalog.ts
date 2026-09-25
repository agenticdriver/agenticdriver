import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DriverError } from "../errors.js";
import { runProcess } from "./cli-process.js";

const modelId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,199}$/);
const catalog = z.object({
  models: z
    .array(
      z.object({
        value: modelId,
        resolvedModel: modelId.optional(),
      }),
    )
    .max(10_000),
});

/** Official SDK initialize metadata, in a separate process with no user messages. */
export async function claudeCatalog(
  binary: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal },
): Promise<{ models: string[]; complete: boolean } | undefined> {
  const version = await runProcess(binary, ["--version"], options);
  // The initialization contract is qualified against this native release.
  // Other versions retain the existing honest configured/incomplete inventory.
  if (!/^2\.1\.282 \(Claude Code\)\s*$/.test(version)) return undefined;
  const requestId = randomUUID();
  let end = () => {};
  let result: { models: string[]; complete: boolean } | undefined;
  const invalid = () =>
    new DriverError(
      "INVALID_DISCOVERY_RESPONSE",
      "Claude returned an unsupported model catalog response.",
    );
  await runProcess(binary, [...args, "--input-format", "stream-json"], {
    ...options,
    retainOutput: false,
    onStart(write, close) {
      end = close;
      write(
        JSON.stringify({
          type: "control_request",
          request_id: requestId,
          request: { subtype: "initialize", hooks: {}, sdkMcpServers: [] },
        }) + "\n",
      );
    },
    onLine(line) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw invalid();
      }
      if (!value || typeof value !== "object") throw invalid();
      const event = value as Record<string, unknown>;
      // Local status notifications contain no catalog or authority. Never publish them.
      if (event.type === "system" && event.subtype === "commands_changed")
        return;
      if (event.type !== "control_response" || result) throw invalid();
      const response = event.response as Record<string, unknown> | undefined;
      if (
        !response ||
        response.request_id !== requestId ||
        response.subtype !== "success"
      )
        throw invalid();
      const parsed = catalog.safeParse(response.response);
      if (!parsed.success) throw invalid();
      const models = new Set<string>();
      for (const row of parsed.data.models) {
        models.add(row.value);
        if (row.resolvedModel) models.add(row.resolvedModel);
      }
      result = {
        models: [...models].slice(0, 1000),
        complete: models.size <= 1000,
      };
      end();
    },
  });
  if (!result) throw invalid();
  return result;
}
