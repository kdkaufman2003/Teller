import type { IntelligenceJournalEntry } from "./types";

export type AnomalyFinding = {
  fingerprint: string;
  title: string;
  description: string;
  confidence: number;
  href?: string;
  resourceKind?: string;
  resourceId?: string;
};

export function detectLargeJournalEntries(
  entries: IntelligenceJournalEntry[],
  monthlyRevenue: number,
  threshold = 5000,
): AnomalyFinding[] {
  const findings: AnomalyFinding[] = [];
  const dynamicThreshold = Math.max(threshold, monthlyRevenue * 0.25);

  for (const entry of entries) {
    if (entry.totalDebit < dynamicThreshold) continue;
    findings.push({
      fingerprint: `anomaly:journal:large:${entry.id}`,
      title: "Large journal entry",
      description: `${entry.memo || "Journal entry"} on ${entry.entry_date} totals $${entry.totalDebit.toFixed(2)} — review for accuracy.`,
      confidence: 0.82,
      href: "/app/ledger",
      resourceKind: "journal_entry",
      resourceId: entry.id,
    });
  }

  return findings;
}

export function detectDuplicateAmounts(entries: IntelligenceJournalEntry[]): AnomalyFinding[] {
  const byKey = new Map<string, IntelligenceJournalEntry[]>();

  for (const entry of entries) {
    const key = `${entry.entry_date}:${Math.round(entry.totalDebit * 100)}`;
    const group = byKey.get(key) ?? [];
    group.push(entry);
    byKey.set(key, group);
  }

  const findings: AnomalyFinding[] = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const [first, second] = group;
    findings.push({
      fingerprint: `anomaly:journal:duplicate:${first.id}:${second.id}`,
      title: "Possible duplicate entry",
      description: `Two entries on ${first.entry_date} for $${first.totalDebit.toFixed(2)} — confirm this is not a duplicate posting.`,
      confidence: 0.7,
      href: "/app/ledger",
      resourceKind: "journal_entry",
      resourceId: first.id,
    });
  }

  return findings.slice(0, 3);
}

export function detectExpenseSpike(
  monthlyTotals: { month: string; amount: number }[],
): AnomalyFinding | null {
  if (monthlyTotals.length < 3) return null;

  const recent = monthlyTotals.at(-1)?.amount ?? 0;
  const prior = monthlyTotals.slice(0, -1).map((row) => row.amount);
  const average = prior.reduce((sum, value) => sum + value, 0) / Math.max(prior.length, 1);

  if (average <= 0 || recent <= average * 1.75) return null;

  return {
    fingerprint: `anomaly:expense:spike:${monthlyTotals.at(-1)?.month}`,
    title: "Expense spike this month",
    description: `Posted expenses are ${Math.round((recent / average - 1) * 100)}% above your recent average — spot-check large vendors.`,
    confidence: 0.68,
    href: "/app/expenses",
  };
}

export function detectAnomalies(input: {
  journalEntries: IntelligenceJournalEntry[];
  monthlyRevenue: number;
  monthlyExpenses: { month: string; amount: number }[];
}): AnomalyFinding[] {
  return [
    ...detectLargeJournalEntries(input.journalEntries, input.monthlyRevenue),
    ...detectDuplicateAmounts(input.journalEntries),
    ...(detectExpenseSpike(input.monthlyExpenses) ? [detectExpenseSpike(input.monthlyExpenses)!] : []),
  ];
}
