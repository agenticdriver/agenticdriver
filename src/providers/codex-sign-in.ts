import { lstat, readdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { DriverError } from "../errors.js";
import { cliEnvironment, runProcess } from "./cli-process.js";

export interface NativeSignInAccount {
  email: string | null;
  plan: string;
  providerAccountId?: string;
}
export interface NativeSignInInteraction {
  type: "device-code";
  verificationUrl: "https://auth.openai.com/codex/device";
  userCode: string;
}
const object = z.record(z.string(), z.unknown());
const fail = (code: string, message: string): never => {
  throw new DriverError(code, message);
};
const invalid = () =>
  fail(
    "SETUP_PROTOCOL_ERROR",
    "The native runtime returned an unsupported sign-in response.",
  );

/** Login, token exchange, persistence and refresh belong to the official native runtime.
 * The caller must supply a new, empty, private account directory; shared accounts are never replaced.
 */
export async function codexDeviceSignIn(options: {
  binary?: string;
  accountDirectory: string;
  signal: AbortSignal;
  interaction(value: NativeSignInInteraction): void;
  verifying(): void;
}): Promise<NativeSignInAccount> {
  if (process.platform !== "linux" || process.arch !== "x64")
    fail(
      "SETUP_UNAVAILABLE",
      "Owned Codex sign-in currently requires the qualified Linux x64 runtime.",
    );
  const directory = options.accountDirectory;
  if (!isAbsolute(directory)) invalid();
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid!() ||
    info.mode & 0o077 ||
    (await readdir(directory)).length
  )
    fail(
      "SETUP_PROFILE_UNSAFE",
      "Sign-in requires a new private account profile.",
    );
  const env = cliEnvironment();
  env.CODEX_HOME = directory;
  const binary = options.binary ?? "codex";
  const version = await runProcess(binary, ["--version"], {
    env,
    cwd: directory,
    signal: options.signal,
  });
  if (version.trim() !== "codex-cli 0.157.0")
    fail(
      "CLI_UPGRADE_REQUIRED",
      "This sign-in method requires the qualified Codex CLI 0.157.0 executable.",
    );

  let send: (value: unknown) => void, end: () => void;
  let expected = 1,
    loginId: string | undefined;
  let completion: { loginId: string; success: boolean } | undefined;
  let verified: NativeSignInAccount | undefined;
  const verify = () => {
    if (!loginId || !completion) return;
    if (completion.loginId !== loginId) invalid();
    if (!completion.success)
      fail(
        "SETUP_SIGN_IN_FAILED",
        "Codex did not complete sign-in. Check the provider's account requirements and try again.",
      );
    if (expected !== 3) invalid();
    expected = 4;
    options.verifying();
    send({
      id: expected,
      method: "account/read",
      params: { refreshToken: false },
    });
  };
  try {
    await runProcess(
      binary,
      [
        "app-server",
        "--stdio",
        "--strict-config",
        "-c",
        'cli_auth_credentials_store="file"',
        "-c",
        'model_provider="openai"',
        "-c",
        "features.apps=false",
        "-c",
        "features.plugins=false",
        "-c",
        "features.hooks=false",
        "-c",
        "features.remote_control=false",
      ],
      {
        env,
        cwd: directory,
        signal: options.signal,
        retainOutput: false,
        onStart(write, close) {
          send = (value) => write(JSON.stringify(value) + "\n");
          end = close;
          send({
            id: 1,
            method: "initialize",
            params: {
              clientInfo: { name: "agenticdriver_setup", version: "0.1.0" },
            },
          });
        },
        onLine(line) {
          const message = object.parse(JSON.parse(line));
          if (message.method !== undefined) {
            // This flow never starts a thread, executes a tool or answers server authority requests.
            if (typeof message.method !== "string" || message.id !== undefined)
              invalid();
            if (message.method === "account/login/completed") {
              if (completion) invalid();
              completion = z
                .object({ loginId: z.uuid(), success: z.boolean() })
                .parse(message.params);
              verify();
            }
            return;
          }
          if (message.id !== expected || verified) invalid();
          if (message.error !== undefined)
            fail(
              "SETUP_SIGN_IN_FAILED",
              "The native runtime could not start or verify sign-in. Check its version and provider access.",
            );
          const result = object.parse(message.result);
          if (expected === 1) {
            send({ method: "initialized" });
            expected = 2;
            send({
              id: expected,
              method: "account/read",
              params: { refreshToken: false },
            });
          } else if (expected === 2) {
            if (result.account != null)
              fail(
                "SETUP_PROFILE_UNSAFE",
                "This profile already has an account. Existing sign-ins cannot be replaced by this flow.",
              );
            expected = 3;
            send({
              id: expected,
              method: "account/login/start",
              params: { type: "chatgptDeviceCode" },
            });
          } else if (expected === 3) {
            const login = z
              .object({
                type: z.literal("chatgptDeviceCode"),
                loginId: z.uuid(),
                verificationUrl: z.literal(
                  "https://auth.openai.com/codex/device",
                ),
                userCode: z.string().regex(/^[A-Z0-9-]{4,40}$/),
              })
              .parse(result);
            loginId = login.loginId;
            options.interaction({
              type: "device-code",
              verificationUrl: login.verificationUrl,
              userCode: login.userCode,
            });
            verify();
          } else if (expected === 4) {
            const account = z
              .object({
                account: z.object({
                  type: z.literal("chatgpt"),
                  email: z.string().max(320).nullable(),
                  planType: z.string().min(1).max(80),
                }),
                workspaceRouting: z
                  .object({ chatgptAccountId: z.string().min(1).max(256) })
                  .nullish(),
              })
              .parse(result);
            verified = {
              email: account.account.email,
              plan: account.account.planType,
              ...(account.workspaceRouting
                ? {
                    providerAccountId:
                      account.workspaceRouting.chatgptAccountId,
                  }
                : {}),
            };
            end();
          } else invalid();
        },
      },
    );
  } catch (error) {
    if (error instanceof DriverError) throw error;
    invalid();
  }
  return verified ?? invalid();
}
