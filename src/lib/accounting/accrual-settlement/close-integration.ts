import type { CloseFinding } from "../close-readiness";
import type { OccurrenceSettlementStatus } from "./types";

export type AccrualSettlementCloseItem = {
  occurrenceId: string;
  scheduleId: string;
  scheduleName: string;
  occurrenceDate: string;
  accruedAmount: number;
  settledAmount: number;
  remainingAmount: number;
  settlementStatus: OccurrenceSettlementStatus;
  expectedSettlementDate?: string | null;
  varianceAmount?: number;
  failedSettlement?: boolean;
};

export function classifyAccrualSettlementCloseFinding(item: AccrualSettlementCloseItem): CloseFinding {
  if (item.failedSettlement) {
    return {
      key: `accrual_settlement_failed_${item.occurrenceId}`,
      domain: "accrual_settlements",
      severity: "blocker",
      title: `Failed accrual settlement: ${item.scheduleName}`,
      description: `Occurrence ${item.occurrenceDate} requires settlement review`,
      route: `/app/accounting/schedules/${item.scheduleId}/occurrences/${item.occurrenceId}`,
    };
  }

  if (item.settlementStatus === "partially_settled") {
    return {
      key: `accrual_partial_${item.occurrenceId}`,
      domain: "accrual_settlements",
      severity: "warning",
      title: `Partially settled accrual: ${item.scheduleName}`,
      description: `$${item.remainingAmount.toFixed(2)} of $${item.accruedAmount.toFixed(2)} remains unsettled (${item.occurrenceDate})`,
      route: `/app/accounting/accrual-settlements?occurrence=${item.occurrenceId}`,
    };
  }

  if (item.settlementStatus === "unsettled") {
    const pastExpected =
      item.expectedSettlementDate != null &&
      item.occurrenceDate.slice(0, 10) <= item.expectedSettlementDate.slice(0, 10);
    const largeVariance =
      item.varianceAmount != null && Math.abs(item.varianceAmount) >= item.accruedAmount * 0.25;

    if (largeVariance) {
      return {
        key: `accrual_variance_${item.occurrenceId}`,
        domain: "accrual_settlements",
        severity: "warning",
        title: `Large accrual variance risk: ${item.scheduleName}`,
        description: `Unsettled accrual ${item.occurrenceDate} may differ materially from actual bill`,
        route: `/app/accounting/accrual-settlements?occurrence=${item.occurrenceId}`,
      };
    }

    if (pastExpected) {
      return {
        key: `accrual_unsettled_${item.occurrenceId}`,
        domain: "accrual_settlements",
        severity: "warning",
        title: `Unsettled accrual: ${item.scheduleName}`,
        description: `$${item.accruedAmount.toFixed(2)} accrued on ${item.occurrenceDate} awaits vendor bill`,
        route: `/app/accounting/accrual-settlements?occurrence=${item.occurrenceId}`,
      };
    }

    return {
      key: `accrual_unsettled_info_${item.occurrenceId}`,
      domain: "accrual_settlements",
      severity: "informational",
      title: `Accrual pending settlement: ${item.scheduleName}`,
      description: `$${item.accruedAmount.toFixed(2)} accrued — bill not yet received`,
      route: `/app/accounting/accrual-settlements?occurrence=${item.occurrenceId}`,
    };
  }

  return {
    key: `accrual_settled_${item.occurrenceId}`,
    domain: "accrual_settlements",
    severity: "informational",
    title: item.scheduleName,
    description: "Accrual settled or no action required",
    route: `/app/accounting/schedules/${item.scheduleId}`,
  };
}

export function filterBlockingAccrualFindings(findings: CloseFinding[]): CloseFinding[] {
  return findings.filter((finding) => finding.severity === "blocker");
}

export function filterAccrualWarnings(findings: CloseFinding[]): CloseFinding[] {
  return findings.filter((finding) => finding.severity === "warning");
}
