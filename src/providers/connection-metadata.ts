import { z } from "zod";
import {
  ProviderConnectionMetadataSchema,
  type ProviderConnectionMetadata,
} from "../types.js";

type Account = NonNullable<ProviderConnectionMetadata["account"]>;
const accountSchema = ProviderConnectionMetadataSchema.shape.account.unwrap();
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\u0000-\u001f\u007f]*$/);

/** Extract only documented display fields. Never return raw status, paths, IDs or credentials. */
export function codexAccount(value: unknown): Account | undefined {
  const parsed = z
    .object({
      account: z
        .discriminatedUnion("type", [
          z.object({
            type: z.literal("chatgpt"),
            email: text(320).nullish(),
            planType: text(120).nullish(),
          }),
          z.object({ type: z.literal("apiKey") }),
        ])
        .nullable(),
    })
    .safeParse(value);
  if (!parsed.success) return undefined;
  const account = parsed.data.account;
  if (!account) return { status: "signed-out" };
  if (account.type === "apiKey")
    return { status: "signed-in", method: "API key" };
  return {
    status: "signed-in",
    method: "ChatGPT",
    ...(account.email ? { email: account.email } : {}),
    ...(account.planType ? { subscription: account.planType } : {}),
  };
}

export function claudeAccount(output: string, signedIn: boolean): Account {
  const fallback: Account = { status: signedIn ? "signed-in" : "signed-out" };
  try {
    const parsed = z
      .object({
        loggedIn: z.boolean(),
        authMethod: text(80).nullish(),
        email: text(320).nullish(),
        subscriptionType: text(120).nullish(),
      })
      .safeParse(JSON.parse(output));
    if (!parsed.success || parsed.data.loggedIn !== signedIn || !signedIn)
      return fallback;
    const value = parsed.data;
    return accountSchema.parse({
      status: "signed-in",
      method: value.authMethod ?? undefined,
      email: value.email ?? undefined,
      subscription: value.subscriptionType ?? undefined,
    });
  } catch {
    return fallback;
  }
}

export function cliVersion(
  kind: "codex" | "claude-code" | "gemini-cli",
  output: string,
): ProviderConnectionMetadata["runtime"] {
  const pattern = {
    codex: /^codex-cli (\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)$/,
    "claude-code": /^(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?) \(Claude Code\)$/,
    "gemini-cli": /^(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)$/,
  }[kind];
  const version = output.trim().match(pattern)?.[1];
  if (!version || version.length > 80) return undefined;
  return {
    name: {
      codex: "Codex CLI",
      "claude-code": "Claude Code",
      "gemini-cli": "Gemini CLI",
    }[kind],
    version,
  };
}
