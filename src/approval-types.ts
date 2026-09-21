import { z } from "zod";

/** Interactive approval is a required, explicitly selected protocol extension. */
export const ApprovalPolicySchema = z
  .object({
    mode: z.literal("interactive"),
    idlePolicy: z.enum(["pause", "continue"]),
    /** No approval deadline unless the application selects one. */
    expiresAfterMs: z.number().int().min(1).max(2_147_483_647).optional(),
  })
  .strict();
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;

export const ApprovalCallSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/),
  arguments: z.record(z.string(), z.json()),
});
export const ApprovalRequestSchema = z.object({
  approvalId: z.string().min(1),
  runId: z.string().min(1),
  call: ApprovalCallSchema,
  requestedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
  idlePolicy: z.enum(["pause", "continue"]),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalDecisionSchema = z
  .object({
    approvalId: z.string().min(1).max(256),
    runId: z.string().min(1).max(256),
    call: ApprovalCallSchema.strict(),
    decision: z.enum(["approve", "deny", "cancel"]),
  })
  .strict();
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ApprovalResolutionSchema = z.object({
  approvalId: z.string().min(1),
  runId: z.string().min(1),
  callId: z.string().min(1),
  outcome: z.enum(["approved", "denied", "cancelled", "expired"]),
  decidedAt: z.iso.datetime({ offset: true }),
});
export type ApprovalResolution = z.infer<typeof ApprovalResolutionSchema>;

export function matchesApprovalDecision(
  result: ApprovalResolution,
  decision: ApprovalDecision,
): boolean {
  return (
    result.approvalId === decision.approvalId &&
    result.runId === decision.runId &&
    result.callId === decision.call.id &&
    result.outcome ===
      {
        approve: "approved",
        deny: "denied",
        cancel: "cancelled",
      }[decision.decision]
  );
}
