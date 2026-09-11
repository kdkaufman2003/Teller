import type { TaxFilingPeriodStatus } from "../filing/types";
import type { TaxOwnerPeriodSummary } from "./types";

const ACTIONABLE_STATUSES: TaxFilingPeriodStatus[] = [
  "open",
  "ready_for_review",
  "reviewed",
  "filed",
  "needs_review",
];

function periodPriority(period: TaxOwnerPeriodSummary, asOf: string): number {
  if (period.remaining > 0) return 1;
  if (period.status === "ready_for_review" || period.status === "needs_review") return 2;
  if (period.status === "open" && period.periodEnd <= asOf) return 3;
  if (period.status === "reviewed") return 4;
  if (period.status === "filed" && period.remaining <= 0) return 6;
  if (period.status === "open" && period.periodEnd > asOf) return 5;
  if (period.status === "closed") return 7;
  return 8;
}

export function selectNextFilingPeriod(
  periods: TaxOwnerPeriodSummary[],
  asOf: string,
): TaxOwnerPeriodSummary | null {
  const candidates = periods.filter((period) => ACTIONABLE_STATUSES.includes(period.status));
  if (!candidates.length) return null;

  const ranked = [...candidates].sort((left, right) => {
    const priorityDiff = periodPriority(left, asOf) - periodPriority(right, asOf);
    if (priorityDiff !== 0) return priorityDiff;
    if (left.periodEnd !== right.periodEnd) return left.periodEnd.localeCompare(right.periodEnd);
    return left.periodStart.localeCompare(right.periodStart);
  });

  return ranked[0] ?? null;
}
