/** Production scheduler configuration — cron remains disabled until authorized. */

export const PRODUCTION_SCHEDULER_ENABLED =
  process.env.PRODUCTION_SCHEDULER_ENABLED === "true";

export const SCHEDULER_DEFAULT_BATCH_SIZE = Number(process.env.SCHEDULER_BATCH_SIZE ?? 50);

export const SCHEDULER_MAX_EXECUTION_MS = Number(process.env.SCHEDULER_MAX_EXECUTION_MS ?? 55_000);

export const SCHEDULER_ELIGIBLE_TYPES = (
  process.env.SCHEDULER_ELIGIBLE_TYPES ?? "prepaid_expense,accrued_expense,deferred_revenue"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

export const SCHEDULER_DRY_RUN = process.env.SCHEDULER_DRY_RUN === "true";

export const SCHEDULER_CRON_SECRET = process.env.SCHEDULER_CRON_SECRET ?? process.env.CRON_SECRET ?? "";

/** Recommended Vercel cron — DO NOT enable until PRODUCTION_SCHEDULER_ENABLED=true */
export const RECOMMENDED_CRON_SCHEDULE = "0 * * * *"; // hourly

export type SchedulerConfig = {
  enabled: boolean;
  batchSize: number;
  maxExecutionMs: number;
  eligibleTypes: string[];
  dryRun: boolean;
};

export function loadSchedulerConfig(): SchedulerConfig {
  return {
    enabled: PRODUCTION_SCHEDULER_ENABLED,
    batchSize: Math.max(1, Math.min(500, SCHEDULER_DEFAULT_BATCH_SIZE)),
    maxExecutionMs: Math.max(5_000, Math.min(120_000, SCHEDULER_MAX_EXECUTION_MS)),
    eligibleTypes: SCHEDULER_ELIGIBLE_TYPES,
    dryRun: SCHEDULER_DRY_RUN,
  };
}

export function assertSchedulerAuthorized(authHeader: string | null): void {
  if (!SCHEDULER_CRON_SECRET) {
    throw new Error("Scheduler secret is not configured");
  }
  const token = authHeader?.replace(/^Bearer\s+/i, "").trim();
  if (!token || token !== SCHEDULER_CRON_SECRET) {
    throw new Error("Unauthorized scheduler invocation");
  }
}
