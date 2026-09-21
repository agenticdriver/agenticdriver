import { z } from "zod";
import { ApprovalCallSchema } from "./approval-types.js";

const name = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/);
export const ApplicationToolDefinitionSchema = z
  .object({
    name,
    description: z.string().min(1).max(10_000),
    inputSchema: z.record(z.string(), z.unknown()),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    /** Applications can add review requirements, never remove host requirements. */
    requiresApproval: z.boolean().optional(),
  })
  .strict();
export type ApplicationToolDefinition = z.infer<
  typeof ApplicationToolDefinitionSchema
>;
export const ApplicationToolGrantSchema = z
  .object({
    name,
    /** Remote application tools require review unless this grant explicitly permits otherwise. */
    requiresApproval: z.boolean().optional(),
  })
  .strict();
export type ApplicationToolGrant = z.infer<typeof ApplicationToolGrantSchema>;

const identity = {
  executionId: z.string().min(1).max(256),
  runId: z.string().min(1).max(256),
  callId: z.string().min(1).max(256),
};
export const ToolExecutionIdentitySchema = z.object(identity).strict();
export type ToolExecutionIdentity = z.infer<typeof ToolExecutionIdentitySchema>;
export const ToolExecutionRequestSchema = z.object({
  executionId: identity.executionId,
  runId: identity.runId,
  call: ApprovalCallSchema,
});
export type ToolExecutionRequest = z.infer<typeof ToolExecutionRequestSchema>;
export const ToolExecutionResultSchema = z.union([
  z.object({ ...identity, output: z.json() }).strict(),
  // Raw exception messages and stacks never cross the application boundary.
  z
    .object({ ...identity, error: z.literal("APPLICATION_TOOL_FAILED") })
    .strict(),
]);
export type ToolExecutionResult = z.infer<typeof ToolExecutionResultSchema>;
export const ToolExecutionReceiptSchema = z.object({
  ...identity,
  status: z.enum(["progress", "accepted"]),
});
export type ToolExecutionReceipt = z.infer<typeof ToolExecutionReceiptSchema>;
export function matchesToolReceipt(
  receipt: ToolExecutionReceipt,
  identity: ToolExecutionIdentity,
  status: ToolExecutionReceipt["status"],
): boolean {
  return (
    receipt.executionId === identity.executionId &&
    receipt.runId === identity.runId &&
    receipt.callId === identity.callId &&
    receipt.status === status
  );
}
