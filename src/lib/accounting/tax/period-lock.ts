/**
 * Tax posting must respect Phase 9 period close locks.
 * 15A establishes the contract; enforcement integrates in 15D via post.ts / periods.ts.
 */
export type PeriodLockCheckInput = {
  transactionDate: string;
  periodEnd: string;
  periodStatus: "open" | "soft_closed" | "closed";
  allowClosedPeriodPosting?: boolean;
};

export function taxPostingBlockedByPeriodLock(input: PeriodLockCheckInput): boolean {
  if (input.allowClosedPeriodPosting) return false;
  if (input.periodStatus === "closed" && input.transactionDate <= input.periodEnd) {
    return true;
  }
  return false;
}

export const PERIOD_LOCK_CONTRACT = {
  usesPhase9Close: true,
  taxSpecificCloseBypass: false,
} as const;
