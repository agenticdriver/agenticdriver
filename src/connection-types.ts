import { z } from "zod";
import { AccessPolicySchema } from "./authorization.js";
import { DriverError } from "./errors.js";
import { secureBaseUrl } from "./security.js";

const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const CreateInvitationSchema = z
  .object({
    grant: AccessPolicySchema,
    expiresInSeconds: z.number().int().min(30).max(3600).default(600),
    connectionLifetimeSeconds: z
      .number()
      .int()
      .min(60)
      .max(7_776_000)
      .default(2_592_000),
  })
  .strict();
export type CreateInvitation = z.input<typeof CreateInvitationSchema>;
export const ConnectionInfoSchema = z.object({
  id: z.uuid(),
  grant: AccessPolicySchema,
  createdAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
});
export const ConnectionInvitationSchema = ConnectionInfoSchema.extend({
  code: opaque,
});
export const ConnectionCredentialsSchema = ConnectionInfoSchema.extend({
  token: opaque,
});
export const ConnectionListSchema = z.object({
  invitations: z.array(ConnectionInfoSchema).max(1000),
  connections: z.array(ConnectionInfoSchema).max(1000),
});
export const RevokeConnectionSchema = z.object({ id: z.uuid() }).strict();
export type ConnectionInfo = z.infer<typeof ConnectionInfoSchema>;
export type ConnectionInvitation = z.infer<typeof ConnectionInvitationSchema>;
export type ConnectionCredentials = z.infer<typeof ConnectionCredentialsSchema>;
export type ConnectionList = z.infer<typeof ConnectionListSchema>;

/** The invitation is a one-use credential. Keep it out of URLs, logs and persistent browser storage. */
export function connectionInvitation(url: string, code: string): string {
  const base = secureBaseUrl(url).href;
  if (!opaque.safeParse(code).success)
    throw new DriverError(
      "INVALID_INVITATION",
      "The connection invitation is invalid.",
    );
  return `ad1.${btoa(base).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}.${code}`;
}
export function connectionTarget(invitation: string): {
  url: string;
  code: string;
} {
  try {
    const parts = invitation.trim().split(".");
    if (
      parts.length !== 3 ||
      parts[0] !== "ad1" ||
      !/^[A-Za-z0-9_-]{1,8192}$/.test(parts[1]!) ||
      !opaque.safeParse(parts[2]).success
    )
      throw new Error();
    const url = secureBaseUrl(
      atob(parts[1]!.replaceAll("-", "+").replaceAll("_", "/")),
    ).href;
    return { url, code: parts[2]! };
  } catch {
    throw new DriverError(
      "INVALID_INVITATION",
      "Use a complete invitation from the selected AgenticDriver host.",
    );
  }
}
