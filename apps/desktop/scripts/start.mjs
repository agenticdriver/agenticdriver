import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const child = spawn(
  require("electron"),
  [fileURLToPath(new URL("../", import.meta.url))],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      NODE_OPTIONS: undefined,
    },
  },
);
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
child.on("error", () => {
  console.error("Run npm run prepare:runtime before starting the desktop.");
  process.exitCode = 1;
});
