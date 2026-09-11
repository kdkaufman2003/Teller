import type { TaxFilingPeriodStatus } from "./types";

const ALLOWED: Record<TaxFilingPeriodStatus, TaxFilingPeriodStatus[]> = {
  open: ["ready_for_review", "needs_review", "closed"],
  needs_review: ["open", "ready_for_review"],
  ready_for_review: ["reviewed", "open", "needs_review"],
  reviewed: ["filed", "ready_for_review"],
  filed: ["closed"],
  closed: [],
};

export function assertFilingPeriodTransition(from: TaxFilingPeriodStatus, to: TaxFilingPeriodStatus): void {
  if (!ALLOWED[from]?.includes(to)) {
    throw new Error(`Invalid filing period transition from ${from} to ${to}`);
  }
}

export function isImmutableFilingPeriodStatus(status: TaxFilingPeriodStatus): boolean {
  return status === "filed" || status === "closed";
}
