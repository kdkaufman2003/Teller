import { asNumber } from "@/lib/format";

export type MatchCandidate = {
  kind: "invoice_payment" | "expense" | "journal";
  resourceId: string;
  label: string;
  amount: number;
  date: string;
  confidence: number;
  reason: string;
};

type BankTransactionLike = {
  id: string;
  amount: number;
  posted_date: string;
  name: string;
};

type InvoiceCandidate = {
  id: string;
  number: string;
  total: number;
  amount_paid: number;
  issue_date: string;
  status: string;
};

type ExpenseCandidate = {
  id: string;
  number: string;
  total: number;
  issue_date: string;
  memo: string;
};

type JournalCandidate = {
  id: string;
  entry_date: string;
  memo: string;
  debit: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function daysApart(a: string, b: string): number {
  const left = new Date(a.slice(0, 10)).getTime();
  const right = new Date(b.slice(0, 10)).getTime();
  return Math.abs(left - right) / DAY_MS;
}

function amountConfidence(bankAmount: number, candidateAmount: number): number {
  const delta = Math.abs(Math.abs(bankAmount) - candidateAmount);
  if (delta < 0.01) return 0.95;
  if (delta <= 1) return 0.8;
  if (delta / Math.max(candidateAmount, 1) <= 0.02) return 0.65;
  return 0;
}

function dateConfidence(bankDate: string, candidateDate: string): number {
  const apart = daysApart(bankDate, candidateDate);
  if (apart <= 1) return 0.9;
  if (apart <= 3) return 0.75;
  if (apart <= 7) return 0.55;
  return 0.2;
}

function combineConfidence(amountScore: number, dateScore: number): number {
  return Math.round((amountScore * 0.7 + dateScore * 0.3) * 100) / 100;
}

/** Suggest Teller records that may match an imported bank line (read-only hints). */
export function suggestBankTransactionMatches(
  transaction: BankTransactionLike,
  input: {
    invoices: InvoiceCandidate[];
    expenses: ExpenseCandidate[];
    journalDeposits: JournalCandidate[];
  },
): MatchCandidate[] {
  const bankAmount = asNumber(transaction.amount);
  const isInflow = bankAmount < 0;
  const targetAmount = Math.abs(bankAmount);
  const candidates: MatchCandidate[] = [];

  if (isInflow) {
    for (const invoice of input.invoices) {
      if (invoice.status !== "paid" && invoice.status !== "open") continue;
      const paid = asNumber(invoice.amount_paid) || asNumber(invoice.total);
      const amountScore = amountConfidence(bankAmount, paid);
      if (amountScore <= 0) continue;
      const confidence = combineConfidence(amountScore, dateConfidence(transaction.posted_date, invoice.issue_date));
      if (confidence < 0.55) continue;
      candidates.push({
        kind: "invoice_payment",
        resourceId: invoice.id,
        label: `Invoice ${invoice.number}`,
        amount: paid,
        date: invoice.issue_date,
        confidence,
        reason: "Amount and date similar to invoice payment",
      });
    }

    for (const entry of input.journalDeposits) {
      const amountScore = amountConfidence(bankAmount, entry.debit);
      if (amountScore <= 0) continue;
      const confidence = combineConfidence(amountScore, dateConfidence(transaction.posted_date, entry.entry_date));
      if (confidence < 0.55) continue;
      candidates.push({
        kind: "journal",
        resourceId: entry.id,
        label: entry.memo || "Journal deposit",
        amount: entry.debit,
        date: entry.entry_date,
        confidence,
        reason: "Amount and date similar to cash journal line",
      });
    }
  } else {
    for (const expense of input.expenses) {
      const amountScore = amountConfidence(bankAmount, asNumber(expense.total));
      if (amountScore <= 0) continue;
      const confidence = combineConfidence(amountScore, dateConfidence(transaction.posted_date, expense.issue_date));
      if (confidence < 0.55) continue;
      candidates.push({
        kind: "expense",
        resourceId: expense.id,
        label: expense.memo ? `${expense.number} · ${expense.memo}` : expense.number,
        amount: asNumber(expense.total),
        date: expense.issue_date,
        confidence,
        reason: "Amount and date similar to expense",
      });
    }
  }

  return candidates.sort((a, b) => b.confidence - a.confidence).slice(0, 5);
}

export function bestSuggestion(candidates: MatchCandidate[]): MatchCandidate | null {
  return candidates[0]?.confidence >= 0.75 ? candidates[0] : null;
}
