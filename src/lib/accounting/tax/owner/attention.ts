import type { TaxReadinessCheck } from "../readiness";
import type { TaxAttentionItem, TaxAttentionSeverity, TaxOwnerPeriodSummary } from "./types";
import { routes } from "@/lib/routes";

type AttentionInput = {
  readinessChecks: TaxReadinessCheck[];
  setupConfigured: boolean;
  needsReviewTransactionCount: number;
  periods: TaxOwnerPeriodSummary[];
  expiredExemptionCount: number;
  rejectedExemptionCount: number;
};

function severityRank(severity: TaxAttentionSeverity): number {
  switch (severity) {
    case "critical":
      return 0;
    case "needs_review":
      return 1;
    default:
      return 2;
  }
}

export function buildTaxAttentionItems(input: AttentionInput): TaxAttentionItem[] {
  const items: TaxAttentionItem[] = [];

  if (!input.setupConfigured) {
    const failedChecks = input.readinessChecks.filter((check) => !check.passed);
    items.push({
      id: "setup-incomplete",
      severity: "critical",
      title: "Tax setup is incomplete",
      description:
        failedChecks.length > 0
          ? `Based on your Teller records, ${failedChecks.length} setup step${failedChecks.length === 1 ? "" : "s"} still need attention.`
          : "Tax is not fully configured yet.",
      actionLabel: "Finish setup",
      actionHref: routes.taxConfigure,
      source: "setup",
    });
  } else {
    for (const check of input.readinessChecks.filter((row) => !row.passed)) {
      items.push({
        id: `setup-${check.key}`,
        severity: "needs_review",
        title: check.ownerLabel,
        description: "This setup item needs attention before filing periods can be trusted.",
        actionLabel: "Configure tax",
        actionHref: routes.taxConfigure,
        source: "setup",
      });
    }
  }

  if (input.needsReviewTransactionCount > 0) {
    items.push({
      id: "transactions-needs-review",
      severity: "needs_review",
      title: `${input.needsReviewTransactionCount} transaction${input.needsReviewTransactionCount === 1 ? "" : "s"} need tax review`,
      description:
        "Teller could not fully determine tax on these transactions. Review them before relying on filing totals.",
      actionLabel: "Review tax issues",
      actionHref: routes.taxReports,
      source: "transaction",
    });
  }

  for (const period of input.periods) {
    if (period.remaining > 0 && (period.status === "filed" || period.status === "reviewed")) {
      items.push({
        id: `period-unpaid-${period.id}`,
        severity: "critical",
        title: `${period.state ?? "Tax"} period has ${formatMoneyShort(period.remaining)} remaining`,
        description: `Filed period ${period.periodStart} – ${period.periodEnd} is not fully paid based on Teller records.`,
        actionLabel: "Record payment",
        actionHref: `${routes.taxPeriods}/${period.id}`,
        source: "payment",
      });
    }

    if ((period.exceptionCount ?? 0) > 0) {
      items.push({
        id: `period-exceptions-${period.id}`,
        severity: "needs_review",
        title: `Filing period has ${period.exceptionCount} reconciliation issue${period.exceptionCount === 1 ? "" : "s"}`,
        description: "Review the period reconciliation before filing or paying.",
        actionLabel: "Review period",
        actionHref: `${routes.taxPeriods}/${period.id}`,
        source: "period",
      });
    }

    if (period.glDifference != null && Math.abs(period.glDifference) > 0.009) {
      items.push({
        id: `period-gl-${period.id}`,
        severity: "needs_review",
        title: "General ledger difference needs review",
        description: `Period ${period.periodStart} – ${period.periodEnd} has a recorded reconciliation difference.`,
        actionLabel: "Review period",
        actionHref: `${routes.taxPeriods}/${period.id}`,
        source: "period",
      });
    }

    if (
      (period.status === "ready_for_review" || period.status === "needs_review") &&
      period.periodEnd <= new Date().toISOString().slice(0, 10)
    ) {
      items.push({
        id: `period-ready-${period.id}`,
        severity: "informational",
        title: `${period.state ?? "Tax"} period is ready for review`,
        description: `Period ${period.periodStart} – ${period.periodEnd} can be reviewed based on your Teller records.`,
        actionLabel: "Review period",
        actionHref: `${routes.taxPeriods}/${period.id}`,
        source: "period",
      });
    }
  }

  if (input.expiredExemptionCount > 0) {
    items.push({
      id: "exemptions-expired",
      severity: "needs_review",
      title: `${input.expiredExemptionCount} exemption certificate${input.expiredExemptionCount === 1 ? "" : "s"} expired`,
      description: "Expired certificates may cause tax to be collected when it should be exempt.",
      actionLabel: "Review exemptions",
      actionHref: routes.taxExemptions,
      source: "exemption",
    });
  }

  if (input.rejectedExemptionCount > 0) {
    items.push({
      id: "exemptions-rejected",
      severity: "needs_review",
      title: `${input.rejectedExemptionCount} exemption certificate${input.rejectedExemptionCount === 1 ? "" : "s"} rejected`,
      description: "Rejected certificates should be corrected or removed.",
      actionLabel: "Review exemptions",
      actionHref: routes.taxExemptions,
      source: "exemption",
    });
  }

  const deduped = new Map<string, TaxAttentionItem>();
  for (const item of items) deduped.set(item.id, item);

  return [...deduped.values()].sort(
    (left, right) => severityRank(left.severity) - severityRank(right.severity),
  );
}

function formatMoneyShort(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}
