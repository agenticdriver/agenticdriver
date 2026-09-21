import { z } from "zod";
import { DriverError } from "./errors.js";
import { JobOperationSchema } from "./job-types.js";
import { SessionOperationSchema } from "./session-types.js";
import { ApplicationToolGrantSchema } from "./tool-types.js";
import { RetrievalIdSchema } from "./retrieval-types.js";

const names = z.array(z.string().min(1).max(256)).max(256);
export const AccessPolicySchema = z
  .object({
    subject: z.string().min(1).max(128),
    providers: names,
    tools: names.default([]),
    approveTools: names.default([]),
    applicationTools: ApplicationToolGrantSchema.array().max(32).default([]),
    jobs: JobOperationSchema.array().max(3).default([]),
    sessions: SessionOperationSchema.array().max(4).default([]),
    retrieval: z
      .object({
        search: RetrievalIdSchema.array().max(256).default([]),
        index: RetrievalIdSchema.array().max(256).default([]),
        delete: RetrievalIdSchema.array().max(256).default([]),
      })
      .default({ search: [], index: [], delete: [] }),
  })
  .refine(
    (policy) =>
      new Set(policy.applicationTools.map((tool) => tool.name)).size ===
      policy.applicationTools.length,
  );
export type AccessPolicy = z.input<typeof AccessPolicySchema>;
export interface AuthenticatedPrincipal extends AccessPolicy {
  /** Opaque authorization reference, never a bearer or provider credential. */
  id: string;
}
export interface HostAuthentication {
  /** Check the current credential and policy on every request. No successful-result cache. */
  authenticate(
    token: string,
    signal: AbortSignal,
  ): Promise<AuthenticatedPrincipal | undefined>;
  /** Required only for detached jobs. Resolve a durable, revocable grant after restart. */
  resolveJobPrincipal?(
    id: string,
    signal: AbortSignal,
  ): Promise<AuthenticatedPrincipal | undefined>;
}
export function accessPolicy(value: unknown) {
  const parsed = AccessPolicySchema.safeParse(value);
  if (!parsed.success)
    throw new DriverError(
      "INVALID_AUTH_POLICY",
      "The host authentication policy is invalid.",
    );
  return parsed.data;
}
export function authenticatedPrincipal(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !value.id.length ||
    value.id.length > 4096 ||
    /[\r\n\0]/.test(value.id)
  )
    throw new DriverError(
      "INVALID_AUTH_POLICY",
      "The host authentication reference is invalid.",
    );
  return { ...accessPolicy(value), id: value.id };
}
