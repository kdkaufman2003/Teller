import type { TaxPeriodReadiness, TaxReconciliationException } from "./types";

export function evaluatePeriodReadiness(exceptions: TaxReconciliationException[]): TaxPeriodReadiness {
  const blockingReasons = exceptions
    .filter((row) => row.severity === "blocking")
    .map((row) => row.message);

  return {
    ready: blockingReasons.length === 0,
    blockingReasons,
  };
}
