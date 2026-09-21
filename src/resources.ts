import { z } from "zod";
import { abortable, DriverError } from "./errors.js";
import { assertPolicyMaps } from "./scheduling.js";
import {
  sumKnownCounts,
  UsageIdSchema,
  type UsageAccumulator,
} from "./usage.js";

export const ObservedBudgetSchema = z
  .object({
    maxTokens: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    maxCostUsd: z.number().finite().positive().optional(),
    /** Missing or partially reported measurements never become zero. */
    unknownUsage: z.enum(["reject", "allow"]),
  })
  .strict();
export type ObservedBudget = z.infer<typeof ObservedBudgetSchema>;
export const ResourceLimitsSchema = z
  .object({
    default: ObservedBudgetSchema.optional(),
    subjects: z
      .record(z.string().min(1).max(128), ObservedBudgetSchema)
      .optional(),
    accounts: z.record(UsageIdSchema, ObservedBudgetSchema).optional(),
  })
  .strict();
export type ResourceLimits = z.infer<typeof ResourceLimitsSchema>;
export interface ResourceIdentity {
  hostId: string;
  accountId?: string;
  subject: string;
  provider: string;
}
export interface ResourceAdmissionContext {
  identity: ResourceIdentity;
  runId: string;
  model: string;
  /** 1-based proposed model step; no messages, tools, metadata or credentials. */
  step: number;
  usage: ReturnType<UsageAccumulator["snapshot"]>;
  signal: AbortSignal;
}
export interface ResourceAdmission {
  /** Trusted application/backend hook; called before every model step. */
  authorize(
    context: ResourceAdmissionContext,
  ): Promise<"allow" | "deny" | "unknown"> | "allow" | "deny" | "unknown";
  unknown: "reject" | "allow";
}

/** Per-run observed usage guards. Durable account-wide accounting stays external. */
export class ResourcePolicy {
  private readonly limits: ResourceLimits;
  private readonly admission?: ResourceAdmission;
  constructor(input?: ResourceLimits, admission?: ResourceAdmission) {
    assertPolicyMaps(input, "INVALID_RESOURCE_POLICY");
    const parsed = ResourceLimitsSchema.safeParse(input ?? {});
    if (
      !parsed.success ||
      (admission &&
        (typeof admission.authorize !== "function" ||
          !["allow", "reject"].includes(admission.unknown)))
    )
      throw new DriverError(
        "INVALID_RESOURCE_POLICY",
        "Resource limits and admission hooks require an explicit unknown-usage policy.",
      );
    this.limits = parsed.data;
    if (admission)
      this.admission = {
        authorize: admission.authorize.bind(admission),
        unknown: admission.unknown,
      };
  }
  select(identity: ResourceIdentity): ObservedBudget[] {
    if (Object.keys(this.limits.accounts ?? {}).length && !identity.accountId)
      throw new DriverError(
        "ADMISSION_IDENTITY_REQUIRED",
        "Account budgets require a trusted host and account binding for this provider.",
      );
    return [
      this.limits.default,
      this.limits.subjects &&
      Object.hasOwn(this.limits.subjects, identity.subject)
        ? this.limits.subjects[identity.subject]
        : undefined,
      identity.accountId &&
      this.limits.accounts &&
      Object.hasOwn(this.limits.accounts, identity.accountId)
        ? this.limits.accounts[identity.accountId]
        : undefined,
    ].filter((limit): limit is ObservedBudget => limit !== undefined);
  }
  check(
    budgets: ObservedBudget[],
    meter: UsageAccumulator,
    continuing: boolean,
  ) {
    const { usage, observedUsage, coverage } = meter.snapshot();
    if (!coverage.startedSteps) return;
    for (const budget of budgets) {
      // The accumulator drops overflowing totals instead of emitting infinity.
      // A reported field with no retained subtotal identifies that overflow;
      // it necessarily exceeds every representable cap of the same unit.
      const overflow = (field: "inputTokens" | "outputTokens" | "costUsd") =>
        (coverage.reportedSteps[field] ?? 0) > 0 &&
        observedUsage[field] === undefined;
      if (
        (budget.maxTokens !== undefined &&
          (overflow("inputTokens") || overflow("outputTokens"))) ||
        (budget.maxCostUsd !== undefined && overflow("costUsd"))
      )
        throw new DriverError(
          "RESOURCE_LIMIT",
          "Reported generation usage exceeded the supported accounting range and this run's resource limit. Reconcile usage before replacement work.",
        );
      const metrics = [
        {
          limit: budget.maxTokens,
          value: sumKnownCounts(usage.inputTokens, usage.outputTokens),
          observed:
            observedUsage.inputTokens === undefined &&
            observedUsage.outputTokens === undefined
              ? undefined
              : (observedUsage.inputTokens ?? 0) +
                (observedUsage.outputTokens ?? 0),
        },
        {
          limit: budget.maxCostUsd,
          value: usage.costUsd,
          observed: observedUsage.costUsd,
        },
      ];
      for (const { limit, value, observed } of metrics) {
        if (limit === undefined) continue;
        // Even with unknown components, a known lower bound above the cap must
        // stop further work. It does not make the missing total known.
        if (
          (observed !== undefined &&
            (observed > limit || (continuing && observed >= limit))) ||
          (value !== undefined &&
            (value > limit || (continuing && value >= limit)))
        )
          throw new DriverError(
            "RESOURCE_LIMIT",
            "Reported generation usage reached the configured per-run limit. Reconcile this run before starting replacement work.",
          );
        if (value === undefined && budget.unknownUsage === "reject")
          throw new DriverError(
            "RESOURCE_USAGE_UNKNOWN",
            "The provider did not report every measurement required by this run's resource policy. Reconcile usage or explicitly change the host policy.",
          );
      }
    }
  }
  outputLimit(
    budgets: ObservedBudget[],
    meter: UsageAccumulator,
    requested: number,
  ): number {
    const { usage, coverage } = meter.snapshot();
    const used = coverage.startedSteps
      ? sumKnownCounts(usage.inputTokens, usage.outputTokens)
      : 0;
    return Math.min(
      requested,
      ...budgets.flatMap((budget) =>
        budget.maxTokens === undefined || used === undefined
          ? []
          : [Math.max(1, budget.maxTokens - used)],
      ),
    );
  }
  async authorize(context: ResourceAdmissionContext) {
    if (!this.admission) return;
    let decision: "allow" | "deny" | "unknown";
    try {
      decision = await abortable(
        Promise.resolve(this.admission.authorize(context)),
        context.signal,
      );
    } catch {
      context.signal.throwIfAborted();
      throw new DriverError(
        "RESOURCE_POLICY_UNAVAILABLE",
        "The configured resource authority could not authorize work. Restore that service and reconcile any reservation before retrying.",
      );
    }
    if (!["allow", "deny", "unknown"].includes(decision))
      throw new DriverError(
        "RESOURCE_POLICY_UNAVAILABLE",
        "The resource authority returned an invalid admission decision.",
      );
    if (decision === "deny")
      throw new DriverError(
        "RESOURCE_ADMISSION_DENIED",
        "The configured resource authority denied this model step. Review the account or subject allowance before retrying.",
      );
    if (decision === "unknown" && this.admission.unknown === "reject")
      throw new DriverError(
        "RESOURCE_USAGE_UNKNOWN",
        "The resource authority could not establish the available allowance. Refresh or reconcile usage before retrying.",
      );
  }
}
