import { asNumber } from "@/lib/format";
import type { MatchedResourceType } from "./normalize";
import type { MatchConfidenceTier, MatchSuggestionV2 } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const CURRENCY_TOLERANCE = 0.01;

export type BankTransactionForMatch = {
  id: string;
  bank_account_id: string;
  posted_date: string;
  normalized_amount: number;
  amount?: number;
  description?: string;
  name?: string;
  merchant_name?: string | null;
  status?: string;
};

export type PaymentMatchCandidate = {
  id: string;
  payment_type: string;
  amount: number;
  net_amount?: number | null;
  payment_date: string;
  party_id?: string | null;
  reference_number?: string | null;
  journal_entry_id?: string | null;
  external_id?: string | null;
  party_name?: string | null;
  matched_total?: number;
};

export type JournalMatchCandidate = {
  id: string;
  entry_date: string;
  memo: string;
  bank_line_amount: number;
  source_kind?: string | null;
};

const PAYMENT_TYPE_TO_RESOURCE: Record<string, MatchedResourceType> = {
  customer_payment: "customer_payment",
  bill_payment: "bill_payment",
  customer_deposit: "customer_deposit",
  customer_refund: "credit_refund",
  vendor_refund: "credit_refund",
};

function daysApart(a: string, b: string): number {
  const left = new Date(a.slice(0, 10)).getTime();
  const right = new Date(b.slice(0, 10)).getTime();
  return Math.abs(left - right) / DAY_MS;
}

function amountMatches(bankAmount: number, candidateAmount: number): boolean {
  return Math.abs(Math.abs(bankAmount) - candidateAmount) <= CURRENCY_TOLERANCE;
}

function amountScore(bankAmount: number, candidateAmount: number): number {
  const delta = Math.abs(Math.abs(bankAmount) - candidateAmount);
  if (delta <= CURRENCY_TOLERANCE) return 1;
  if (delta <= 1) return 0.85;
  if (delta / Math.max(candidateAmount, 1) <= 0.02) return 0.65;
  return 0;
}

function dateScore(bankDate: string, candidateDate: string): number {
  const apart = daysApart(bankDate, candidateDate);
  if (apart <= 1) return 1;
  if (apart <= 3) return 0.8;
  if (apart <= 7) return 0.55;
  return 0.2;
}

function textOverlap(bankText: string, candidateText: string): number {
  const left = bankText.toLowerCase();
  const right = candidateText.toLowerCase();
  if (!left || !right) return 0;
  if (left.includes(right) || right.includes(left)) return 0.9;
  const leftTokens = new Set(left.split(/\W+/).filter(Boolean));
  const overlap = right.split(/\W+/).filter((token) => leftTokens.has(token)).length;
  return overlap > 0 ? Math.min(0.7, overlap * 0.15) : 0;
}

export function confidenceTierFromScore(score: number, exactAmount: boolean): MatchConfidenceTier {
  if (exactAmount && score >= 0.95) return "exact";
  if (score >= 0.85) return "high";
  if (score >= 0.65) return "medium";
  return "low";
}

function combineScore(parts: number[]): number {
  const sum = parts.reduce((acc, value) => acc + value, 0);
  return Math.round(Math.min(sum, 1) * 100) / 100;
}

function paymentLabel(payment: PaymentMatchCandidate): string {
  const typeLabel = payment.payment_type.replace(/_/g, " ");
  if (payment.party_name) return `${typeLabel} · ${payment.party_name}`;
  if (payment.reference_number) return `${typeLabel} · ${payment.reference_number}`;
  return typeLabel;
}

function paymentResourceType(paymentType: string): MatchedResourceType {
  return PAYMENT_TYPE_TO_RESOURCE[paymentType] ?? "customer_payment";
}

function remainingPaymentAmount(payment: PaymentMatchCandidate): number {
  const gross = asNumber(payment.net_amount ?? payment.amount);
  const matched = asNumber(payment.matched_total ?? 0);
  return Math.max(0, gross - matched);
}

/** Score bank line against teller_payments and bank GL journal entries. */
export function suggestBankTransactionMatchesV2(
  transaction: BankTransactionForMatch,
  input: {
    payments: PaymentMatchCandidate[];
    journalEntries: JournalMatchCandidate[];
  },
): MatchSuggestionV2[] {
  const bankAmount = asNumber(transaction.normalized_amount ?? transaction.amount);
  const bankText = [
    transaction.description ?? transaction.name ?? "",
    transaction.merchant_name ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const candidates: MatchSuggestionV2[] = [];

  for (const payment of input.payments) {
    const available = remainingPaymentAmount(payment);
    if (available <= CURRENCY_TOLERANCE) continue;

    const exactAmount = amountMatches(bankAmount, available);
    const amtScore = amountScore(bankAmount, available);
    if (amtScore <= 0) continue;

    const datePart = dateScore(transaction.posted_date, payment.payment_date);
    const refPart = payment.reference_number
      ? textOverlap(bankText, payment.reference_number)
      : 0;
    const partyPart = payment.party_name ? textOverlap(bankText, payment.party_name) : 0;
    const externalPart = payment.external_id ? textOverlap(bankText, payment.external_id) : 0;

    const confidence = combineScore([
      amtScore * 0.55,
      datePart * 0.2,
      Math.max(refPart, partyPart, externalPart) * 0.25,
    ]);
    if (confidence < 0.45) continue;

    candidates.push({
      resourceType: paymentResourceType(payment.payment_type),
      resourceId: payment.id,
      label: paymentLabel(payment),
      amount: available,
      date: payment.payment_date,
      confidence,
      confidenceTier: confidenceTierFromScore(confidence, exactAmount),
      reason: exactAmount
        ? "Amount and date align with posted payment"
        : "Amount/date/reference similar to payment",
      paymentType: payment.payment_type,
      partyName: payment.party_name ?? null,
      referenceNumber: payment.reference_number ?? null,
    });
  }

  for (const entry of input.journalEntries) {
    const lineAmount = asNumber(entry.bank_line_amount);
    if (lineAmount <= CURRENCY_TOLERANCE) continue;

    const exactAmount = amountMatches(bankAmount, lineAmount);
    const amtScore = amountScore(bankAmount, lineAmount);
    if (amtScore <= 0) continue;

    const datePart = dateScore(transaction.posted_date, entry.entry_date);
    const memoPart = textOverlap(bankText, entry.memo);
    const confidence = combineScore([amtScore * 0.6, datePart * 0.2, memoPart * 0.2]);
    if (confidence < 0.45) continue;

    candidates.push({
      resourceType: "journal_entry",
      resourceId: entry.id,
      label: entry.memo || "Journal entry",
      amount: lineAmount,
      date: entry.entry_date,
      confidence,
      confidenceTier: confidenceTierFromScore(confidence, exactAmount),
      reason: "Amount and date align with bank GL journal line",
    });
  }

  return candidates.sort((a, b) => b.confidence - a.confidence).slice(0, 8);
}

export function bestSuggestionV2(candidates: MatchSuggestionV2[]): MatchSuggestionV2 | null {
  const top = candidates[0];
  if (!top) return null;
  if (top.confidenceTier === "exact" || top.confidenceTier === "high") return top;
  if (top.confidence >= 0.75) return top;
  return null;
}

export function matchAmountForTransaction(
  transaction: BankTransactionForMatch,
  overrideAmount?: number,
): number {
  if (overrideAmount != null) return Math.abs(asNumber(overrideAmount));
  return Math.abs(asNumber(transaction.normalized_amount ?? transaction.amount));
}
