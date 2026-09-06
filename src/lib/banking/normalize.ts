/**
 * Canonical Teller bank amount sign convention (Phase 5).
 * Provider adapters must normalize at ingestion; accounting code uses normalized_amount only.
 */

export type BankGlKind = "asset_bank" | "credit_card_liability";

export type BankDirection =
  | "inflow"
  | "outflow"
  | "charge"
  | "payment"
  | "credit_refund";

export function inferBankGlKind(input: {
  glAccountType?: string | null;
  glAccountSubtype?: string | null;
  bankAccountType?: string | null;
  bankAccountSubtype?: string | null;
}): BankGlKind {
  if (input.glAccountType === "liability") {
    return "credit_card_liability";
  }
  const bankType = (input.bankAccountType ?? "").toLowerCase();
  const bankSubtype = (input.bankAccountSubtype ?? "").toLowerCase();
  if (bankType === "credit" || bankSubtype.includes("credit")) {
    return "credit_card_liability";
  }
  return "asset_bank";
}

/**
 * Convert provider raw amount (e.g. Plaid) to Teller normalized_amount.
 * Plaid asset accounts: negative = inflow → Teller positive inflow.
 * Plaid credit cards: positive = charge → Teller positive charge.
 */
export function normalizeProviderAmount(
  rawAmount: number,
  glKind: BankGlKind,
): number {
  if (!Number.isFinite(rawAmount) || rawAmount === 0) return 0;
  if (glKind === "asset_bank") {
    return -rawAmount;
  }
  return rawAmount;
}

export function directionFromNormalizedAmount(
  normalizedAmount: number,
  glKind: BankGlKind,
): BankDirection | null {
  if (normalizedAmount === 0) return null;
  if (glKind === "asset_bank") {
    return normalizedAmount > 0 ? "inflow" : "outflow";
  }
  if (normalizedAmount > 0) return "charge";
  return "payment";
}

export const BANK_TRANSACTION_STATUSES = [
  "unreviewed",
  "suggested",
  "partially_matched",
  "matched",
  "categorized",
  "excluded",
  "reconciled",
] as const;

export type BankTransactionStatus = (typeof BANK_TRANSACTION_STATUSES)[number];

/** Map legacy match_status (009) to Phase 5 workflow status. */
export function legacyMatchStatusToStatus(
  matchStatus: string,
): BankTransactionStatus {
  switch (matchStatus) {
    case "suggested":
      return "suggested";
    case "matched":
      return "matched";
    case "ignored":
      return "excluded";
    case "unmatched":
    default:
      return "unreviewed";
  }
}

/** Keep legacy APIs readable while status is authoritative. */
export function statusToLegacyMatchStatus(status: BankTransactionStatus): string {
  switch (status) {
    case "suggested":
    case "partially_matched":
      return "suggested";
    case "matched":
    case "categorized":
    case "reconciled":
      return "matched";
    case "excluded":
      return "ignored";
    case "unreviewed":
    default:
      return "unmatched";
  }
}

export function bankTransactionNeedsReview(input: {
  status?: string | null;
  match_status?: string | null;
}): boolean {
  if (input.status) {
    return ["unreviewed", "suggested", "partially_matched"].includes(input.status);
  }
  return input.match_status === "unmatched" || input.match_status === "suggested";
}

export function bankTransactionIsUnreviewed(input: {
  status?: string | null;
  match_status?: string | null;
}): boolean {
  if (input.status) return input.status === "unreviewed";
  return input.match_status === "unmatched";
}

export function bankTransactionHasSuggestion(input: {
  status?: string | null;
  match_status?: string | null;
}): boolean {
  if (input.status) {
    return input.status === "suggested" || input.status === "partially_matched";
  }
  return input.match_status === "suggested";
}

export const MATCHED_RESOURCE_TYPES = [
  "customer_payment",
  "bill_payment",
  "expense_payment",
  "customer_deposit",
  "deposit_refund",
  "credit_refund",
  "payment_reversal",
  "bank_transfer",
  "journal_entry",
  "bank_fee",
  "interest_income",
  "interest_expense",
  "owner_contribution",
  "owner_draw",
  "document",
] as const;

export type MatchedResourceType = (typeof MATCHED_RESOURCE_TYPES)[number];
