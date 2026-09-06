import { classifyExpenseText, type ExpenseAccountOption } from "@/lib/expenses/classify";
import { bankTransactionHasSuggestion, bankTransactionIsUnreviewed } from "@/lib/banking/normalize";
import { money } from "@/lib/format";
import { routes } from "@/lib/routes";
import { detectAnomalies } from "./anomalies";
import type {
  IntelligenceContext,
  IntelligenceInsight,
  IntelligenceReport,
  IntelligenceSuggestion,
} from "./types";

export function buildFinancialNarrative(context: IntelligenceContext): string[] {
  const lines: string[] = [];

  if (context.totalRevenue > 0) {
    lines.push(
      `${context.periodLabel}, you recorded ${money(context.totalRevenue)} in revenue with ${money(context.netIncome)} net income.`,
    );
  } else {
    lines.push(`${context.periodLabel}, revenue has not been posted yet.`);
  }

  if (context.openAR > 0) {
    lines.push(`${money(context.openAR)} is still awaiting payment from customers.`);
  } else if (context.collected > 0) {
    lines.push(`You collected ${money(context.collected)} from paid invoices in this view.`);
  }

  if (context.openAP > 0) {
    lines.push(`${money(context.openAP)} in vendor expenses remain open.`);
  }

  if (context.closedThrough) {
    lines.push(`Books are closed through ${context.closedThrough}; new entries must be dated after that day.`);
  }

  if (lines.length === 1 && context.totalRevenue === 0 && context.openAR === 0) {
    lines.push("Post invoices and expenses to unlock richer insights.");
  }

  return lines;
}

export function buildLiveInsights(context: IntelligenceContext): IntelligenceInsight[] {
  const insights: IntelligenceInsight[] = [];

  if (context.netIncome > 0 && context.totalRevenue > 0) {
    const margin = Math.round((context.netIncome / context.totalRevenue) * 100);
    insights.push({
      id: "margin",
      title: "Profit margin",
      description: `Net income is ${margin}% of revenue ${context.periodLabel.toLowerCase()}.`,
      tone: margin >= 20 ? "positive" : "neutral",
    });
  }

  if (context.openAR > context.collected && context.openAR > 0) {
    insights.push({
      id: "collections",
      title: "Collections opportunity",
      description: "Open receivables exceed recent collections — follow up on overdue invoices.",
      tone: "warning",
    });
  }

  const unmatchedBank = context.bankTransactions.filter((row) => bankTransactionIsUnreviewed(row));
  if (unmatchedBank.length > 0) {
    insights.push({
      id: "bank-unmatched",
      title: "Bank lines to match",
      description: `${unmatchedBank.length} imported bank transaction(s) still need to be matched to books.`,
      tone: "warning",
    });
  }

  const suggestedBank = context.bankTransactions.filter((row) => bankTransactionHasSuggestion(row));
  if (suggestedBank.length > 0) {
    insights.push({
      id: "bank-suggested",
      title: "Reconciliation suggestions ready",
      description: `${suggestedBank.length} bank line(s) have high-confidence match suggestions waiting for review.`,
      tone: "neutral",
    });
  }

  const draftExpenses = context.expenses.filter((row) => row.status === "draft");
  if (draftExpenses.length > 0) {
    insights.push({
      id: "draft-expenses",
      title: "Draft expenses",
      description: `${draftExpenses.length} expense(s) are still draft — post them to keep the ledger current.`,
      tone: "neutral",
    });
  }

  return insights;
}

export function buildScanSuggestions(context: IntelligenceContext): IntelligenceSuggestion[] {
  const suggestions: IntelligenceSuggestion[] = [];

  const anomalies = detectAnomalies({
    journalEntries: context.journalEntries,
    monthlyRevenue: context.monthlyRevenue.at(-1)?.amount ?? context.totalRevenue,
    monthlyExpenses: groupMonthlyTotals(context.expenses),
  });

  for (const finding of anomalies) {
    suggestions.push({
      kind: "anomaly",
      fingerprint: finding.fingerprint,
      title: finding.title,
      description: finding.description,
      confidence: finding.confidence,
      href: finding.href,
      resourceKind: finding.resourceKind,
      resourceId: finding.resourceId,
    });
  }

  for (const txn of context.bankTransactions) {
    if (!bankTransactionIsUnreviewed(txn)) continue;
    const haystack = txn.merchant_name || txn.name;
    const classification = classifyExpenseText(
      context.expenseAccounts as ExpenseAccountOption[],
      { vendorName: haystack, memo: haystack },
    );
    if (!classification.accountId || classification.confidence === "low") continue;

    suggestions.push({
      kind: "categorization",
      fingerprint: `categorization:bank:${txn.id}`,
      title: "Suggested expense category",
      description: `${haystack} may belong in ${classification.accountCode} ${classification.reason}. Review before posting.`,
      confidence: classification.confidence === "high" ? 0.85 : 0.65,
      href: routes.banking,
      payload: {
        accountId: classification.accountId,
        accountCode: classification.accountCode,
        bankTransactionId: txn.id,
      },
      resourceKind: "bank_transaction",
      resourceId: txn.id,
    });
  }

  for (const txn of context.bankTransactions) {
    if (!bankTransactionHasSuggestion(txn)) continue;
    suggestions.push({
      kind: "reconciliation",
      fingerprint: `reconciliation:bank:${txn.id}`,
      title: "Review bank match",
      description: `${txn.name} has a ${Math.round((txn.match_confidence ?? 0.75) * 100)}% match suggestion — confirm or ignore in Banking.`,
      confidence: txn.match_confidence ?? 0.75,
      href: routes.banking,
      resourceKind: "bank_transaction",
      resourceId: txn.id,
    });
  }

  return suggestions.slice(0, 20);
}

function groupMonthlyTotals(
  expenses: IntelligenceContext["expenses"],
): { month: string; amount: number }[] {
  const totals = new Map<string, number>();
  for (const expense of expenses) {
    if (expense.status === "void" || expense.status === "draft") continue;
    const month = expense.issue_date.slice(0, 7);
    totals.set(month, (totals.get(month) ?? 0) + Number(expense.total));
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, amount]) => ({ month, amount }));
}

export function buildIntelligenceReport(input: {
  context: IntelligenceContext;
  persistedSuggestions: IntelligenceSuggestion[];
  aiEnabled: boolean;
}): IntelligenceReport {
  const narrative = buildFinancialNarrative(input.context);
  const insights = buildLiveInsights(input.context);
  const pendingCount = input.persistedSuggestions.length;

  return {
    narrative,
    insights,
    suggestions: input.persistedSuggestions,
    pendingCount,
    aiEnabled: input.aiEnabled,
  };
}

export function mergeScanSuggestions(
  existing: IntelligenceSuggestion[],
  scanned: IntelligenceSuggestion[],
): IntelligenceSuggestion[] {
  const fingerprints = new Set(existing.map((row) => row.fingerprint));
  return [...existing, ...scanned.filter((row) => !fingerprints.has(row.fingerprint))];
}
