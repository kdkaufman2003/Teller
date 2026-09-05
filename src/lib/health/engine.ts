import { routes } from "@/lib/routes";
import type {
  AttentionItem,
  HealthFactor,
  HealthGrade,
  HealthReport,
  HealthSignals,
} from "./types";

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function factorStatus(score: number): HealthFactor["status"] {
  if (score >= 85) return "good";
  if (score >= 60) return "attention";
  return "critical";
}

function gradeFromScore(score: number): HealthGrade {
  if (score >= 90) return "excellent";
  if (score >= 75) return "good";
  if (score >= 55) return "fair";
  return "needs_work";
}

function invoicingFactor(signals: HealthSignals): HealthFactor {
  let score = 100;
  if (signals.draftInvoiceCount > 0) score -= signals.draftInvoiceCount * 12;
  if (signals.overdueInvoiceCount > 0) score -= signals.overdueInvoiceCount * 18;
  score = clampScore(score);

  const parts: string[] = [];
  if (signals.draftInvoiceCount) parts.push(`${signals.draftInvoiceCount} draft`);
  if (signals.overdueInvoiceCount) parts.push(`${signals.overdueInvoiceCount} overdue`);
  if (signals.openInvoiceCount && !signals.overdueInvoiceCount) {
    parts.push(`${signals.openInvoiceCount} awaiting payment`);
  }

  return {
    id: "invoicing",
    label: "Invoicing",
    score,
    weight: 30,
    status: factorStatus(score),
    detail: parts.length ? parts.join(" · ") : "Invoices look current",
  };
}

function expensesFactor(signals: HealthSignals): HealthFactor {
  let score = 100;
  if (signals.draftExpenseCount > 0) score -= signals.draftExpenseCount * 15;
  if (signals.receiptExpenseWithoutAttachment > 0) {
    score -= signals.receiptExpenseWithoutAttachment * 10;
  }
  score = clampScore(score);

  const parts: string[] = [];
  if (signals.draftExpenseCount) parts.push(`${signals.draftExpenseCount} draft`);
  if (signals.receiptExpenseWithoutAttachment) {
    parts.push(`${signals.receiptExpenseWithoutAttachment} missing receipts`);
  }

  return {
    id: "expenses",
    label: "Expenses",
    score,
    weight: 20,
    status: factorStatus(score),
    detail: parts.length ? parts.join(" · ") : "Expenses are recorded",
  };
}

function bankingFactor(signals: HealthSignals): HealthFactor {
  if (!signals.bankConnectionCount) {
    return {
      id: "banking",
      label: "Bank feed",
      score: 100,
      weight: 0,
      status: "good",
      detail: "No bank connected yet",
    };
  }

  let score = 100;
  if (signals.bankConnectionErrorCount > 0) score -= 40;
  score -= signals.unmatchedBankCount * 4;
  score -= signals.suggestedBankCount * 2;
  score = clampScore(score);

  const parts: string[] = [];
  if (signals.bankConnectionErrorCount) parts.push("connection needs attention");
  if (signals.unmatchedBankCount) parts.push(`${signals.unmatchedBankCount} unmatched`);
  if (signals.suggestedBankCount) parts.push(`${signals.suggestedBankCount} to review`);

  return {
    id: "banking",
    label: "Bank feed",
    score,
    weight: 25,
    status: factorStatus(score),
    detail: parts.length ? parts.join(" · ") : "Bank activity is matched",
  };
}

function integrationsFactor(signals: HealthSignals): HealthFactor {
  if (!signals.hfacEnabled) {
    return {
      id: "integrations",
      label: "Integrations",
      score: 100,
      weight: 0,
      status: "good",
      detail: "No platform integration enabled",
    };
  }

  let score = signals.hfacStaleSync ? 65 : 100;
  score = clampScore(score);

  return {
    id: "integrations",
    label: "Integrations",
    score,
    weight: 10,
    status: factorStatus(score),
    detail: signals.hfacStaleSync
      ? "Hassle Free AC sync is stale"
      : signals.hfacLastSyncedAt
        ? "Hassle Free AC is synced"
        : "Hassle Free AC not synced yet",
  };
}

function taxFactor(signals: HealthSignals): HealthFactor {
  let score = 100;
  if (signals.taxPendingReviewCount > 0) {
    score -= signals.taxPendingReviewCount * 20;
  }
  score = clampScore(score);

  return {
    id: "tax",
    label: "Sales tax",
    score,
    weight: 15,
    status: factorStatus(score),
    detail:
      signals.taxPendingReviewCount > 0
        ? `${signals.taxPendingReviewCount} calculation(s) need review`
        : "Tax determinations look consistent",
  };
}

function buildAttention(signals: HealthSignals): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (signals.overdueInvoiceCount > 0) {
    items.push({
      id: "overdue-invoices",
      severity: "warning",
      title: "Overdue invoices",
      description: `${signals.overdueInvoiceCount} open invoice(s) are past due.`,
      href: routes.invoices,
      count: signals.overdueInvoiceCount,
    });
  }

  if (signals.draftInvoiceCount > 0) {
    items.push({
      id: "draft-invoices",
      severity: "info",
      title: "Draft invoices",
      description: `${signals.draftInvoiceCount} invoice(s) are still draft — post them when ready.`,
      href: routes.invoices,
      count: signals.draftInvoiceCount,
    });
  }

  if (signals.draftExpenseCount > 0) {
    items.push({
      id: "draft-expenses",
      severity: "info",
      title: "Draft expenses",
      description: `${signals.draftExpenseCount} expense(s) have not been posted.`,
      href: routes.expenses,
      count: signals.draftExpenseCount,
    });
  }

  if (signals.receiptExpenseWithoutAttachment > 0) {
    items.push({
      id: "missing-receipts",
      severity: "info",
      title: "Missing receipts",
      description: `${signals.receiptExpenseWithoutAttachment} receipt expense(s) have no attachment.`,
      href: routes.expenses,
      count: signals.receiptExpenseWithoutAttachment,
    });
  }

  if (signals.bankConnectionErrorCount > 0) {
    items.push({
      id: "bank-connection-error",
      severity: "critical",
      title: "Bank connection issue",
      description: "A connected bank needs to be re-authenticated or synced again.",
      href: routes.banking,
      count: signals.bankConnectionErrorCount,
    });
  }

  if (signals.unmatchedBankCount > 0 || signals.suggestedBankCount > 0) {
    items.push({
      id: "bank-unmatched",
      severity: signals.unmatchedBankCount > 5 ? "warning" : "info",
      title: "Bank transactions to review",
      description: `${signals.unmatchedBankCount + signals.suggestedBankCount} imported bank line(s) need matching.`,
      href: routes.banking,
      count: signals.unmatchedBankCount + signals.suggestedBankCount,
    });
  }

  if (signals.hfacEnabled && signals.hfacStaleSync) {
    items.push({
      id: "hfac-stale",
      severity: "info",
      title: "Integration sync stale",
      description: "Hassle Free AC has not synced recently — run sync from Settings.",
      href: routes.settings,
    });
  }

  if (signals.taxPendingReviewCount > 0) {
    items.push({
      id: "tax-review",
      severity: "info",
      title: "Tax calculations to review",
      description: `${signals.taxPendingReviewCount} invoice tax line(s) used fallback rules and should be reviewed.`,
      href: routes.invoices,
      count: signals.taxPendingReviewCount,
    });
  }

  const severityRank: Record<AttentionItem["severity"], number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };

  return items.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
}

function weightedScore(factors: HealthFactor[]): number {
  const active = factors.filter((factor) => factor.weight > 0);
  if (!active.length) return 100;
  const totalWeight = active.reduce((sum, factor) => sum + factor.weight, 0);
  const weighted = active.reduce((sum, factor) => sum + factor.score * factor.weight, 0);
  return clampScore(weighted / totalWeight);
}

function buildHeadline(score: number, attentionCount: number, booksCurrentThrough: string | null) {
  if (attentionCount === 0) {
    return booksCurrentThrough
      ? `Your books look current through ${booksCurrentThrough}.`
      : "Your books look caught up.";
  }

  if (score >= 85) {
    return `${attentionCount} small item${attentionCount === 1 ? "" : "s"} need attention.`;
  }
  if (score >= 65) {
    return `${attentionCount} thing${attentionCount === 1 ? "" : "s"} need attention before month-end close.`;
  }
  return `${attentionCount} item${attentionCount === 1 ? "" : "s"} need attention to keep books reliable.`;
}

export function computeHealthReport(signals: HealthSignals): HealthReport {
  const factors = [
    invoicingFactor(signals),
    expensesFactor(signals),
    bankingFactor(signals),
    integrationsFactor(signals),
    taxFactor(signals),
  ];

  const score = weightedScore(factors);
  const grade = gradeFromScore(score);
  const attention = buildAttention(signals);
  const booksCurrentThrough = signals.lastPostedDate?.slice(0, 10) ?? null;

  return {
    score,
    grade,
    headline: buildHeadline(score, attention.length, booksCurrentThrough),
    subheadline:
      attention.length === 0
        ? "Nothing urgent right now."
        : "Review the items below to stay current.",
    factors: factors.filter((factor) => factor.weight > 0 || factor.id === "banking"),
    attention,
    booksCurrentThrough,
  };
}

export function formatHealthGrade(grade: HealthGrade): string {
  switch (grade) {
    case "excellent":
      return "Excellent";
    case "good":
      return "Good";
    case "fair":
      return "Fair";
    case "needs_work":
      return "Needs work";
  }
}
