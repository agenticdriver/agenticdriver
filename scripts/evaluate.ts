import { readFile, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  openai,
  anthropic,
  gemini,
  xaiResponses,
} from "../src/providers/index.js";
import { secretResolver } from "../src/secrets.js";
import { evaluateFixtures, evaluateLive } from "./evaluation-suite.js";

export const LiveConfigurationSchema = z
  .object({
    provider: z.enum(["openai", "anthropic", "gemini", "xai"]),
    model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,199}$/),
    // A non-secret operator label, never a provider credential or email address.
    accountLabel: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/),
    providerVersion: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[^\u0000-\u001f\u007f]*$/),
    apiKeyFile: z.string().min(1).max(4096),
  })
  .strict();

export async function main(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      output: { type: "string" },
      "live-config": { type: "string" },
      "allow-paid": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (Boolean(values["live-config"]) !== values["allow-paid"])
    throw new Error("Live mode requires both --live-config and --allow-paid");
  let evaluate: () =>
    ReturnType<typeof evaluateFixtures> | ReturnType<typeof evaluateLive> =
    evaluateFixtures;
  if (values["live-config"]) {
    const configPath = resolve(values["live-config"]);
    const config = LiveConfigurationSchema.parse(
      JSON.parse(await readFile(configPath, "utf8")),
    );
    const apiKey = await secretResolver(dirname(configPath))({
      file: config.apiKeyFile,
    });
    if (!apiKey.trim())
      throw new Error(
        "The explicitly selected private API key file is empty or unavailable",
      );
    const factory = { openai, anthropic, gemini, xai: xaiResponses }[
      config.provider
    ];
    evaluate = () =>
      evaluateLive({
        provider: factory({ apiKey, models: [config.model] }),
        model: config.model,
        accountLabel: config.accountLabel,
        providerVersion: config.providerVersion,
        acknowledgePaidCalls: true,
      });
  }
  const root = fileURLToPath(new URL("../", import.meta.url));
  const metadata = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  let sourceCommit: string | null = null,
    sourceDirty: boolean | null = null;
  try {
    sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    sourceDirty =
      execFileSync("git", ["status", "--porcelain=v1"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim().length > 0;
  } catch {
    /* A source archive may not retain Git metadata. Never invent provenance. */
  }
  // Reserve a new private report before any paid call; a bad/existing path
  // must not spend usage and then fail to save the result.
  const outputFile = values.output
    ? await open(values.output, "wx", 0o600)
    : undefined;
  try {
    const report = await evaluate();
    const result = {
      reportVersion: 1,
      evaluatedAt: new Date().toISOString(),
      sdkVersion: metadata.version,
      sourceCommit,
      sourceDirty,
      ...report,
    };
    const content = JSON.stringify(result, null, 2) + "\n";
    if (outputFile) await outputFile.writeFile(content);
    else process.stdout.write(content);
    return result.passed ? 0 : 1;
  } finally {
    await outputFile?.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch {
    // Configuration paths, provider error bodies, output and credentials stay private.
    process.stderr.write(
      "Evaluation could not complete. Check explicit arguments and private configuration; no automatic retry or fallback was attempted.\n",
    );
    process.exitCode = 1;
  }
}
