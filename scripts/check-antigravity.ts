/** Exercise the production gate without sending application content or invoking a model. */
import { parseArgs } from "node:util";
import type { checkAntigravityGate } from "../src/providers/antigravity.js";

const { values } = parseArgs({
  options: {
    binary: { type: "string" },
    model: { type: "string" },
    "account-directory": { type: "string" },
  },
});
if (!values.binary || !values.model) {
  console.error(
    "Provide --binary ABSOLUTE_PATH --model SELECTED_MODEL, optionally --account-directory PATH.",
  );
  process.exitCode = 2;
} else {
  try {
    const production = (await import(
      new URL("../dist/providers/antigravity.js", import.meta.url).href
    )) as { checkAntigravityGate: typeof checkAntigravityGate };
    console.log(
      JSON.stringify(
        await production.checkAntigravityGate({
          binary: values.binary,
          model: values.model,
          accountDirectory: values["account-directory"],
          signal: AbortSignal.timeout(60_000),
        }),
      ),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        status: "unavailable",
        code:
          error instanceof Error &&
          "code" in error &&
          typeof error.code === "string" &&
          [
            "CLI_AUTH_REQUIRED",
            "CLI_UPGRADE_REQUIRED",
            "CLI_UNAVAILABLE",
            "CLI_POLICY_VIOLATION",
            "STORAGE_UNSAFE",
            "UNSUPPORTED_PLATFORM",
          ].includes(error.code)
            ? error.code
            : "CLI_GATE_UNAVAILABLE",
        applicationPromptSubmitted: false,
        liveCertified: false,
      }),
    );
    process.exitCode = 1;
  }
}
