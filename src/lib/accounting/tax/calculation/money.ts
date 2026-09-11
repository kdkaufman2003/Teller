import { roundMoney } from "@/lib/accounting/payment-fees";

/** Exact-cent helpers — avoid floating-point drift in tax calculations. */
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export function fromCents(cents: number): number {
  return roundMoney(cents / 100);
}

export function taxFromBasisCents(basisCents: number, ratePercent: number): number {
  if (basisCents <= 0 || ratePercent <= 0) return 0;
  return Math.round((basisCents * ratePercent) / 100);
}

export function resolveLineAmount(input: {
  lineAmount?: number;
  quantity?: number;
  unitAmount?: number;
}): number {
  if (input.lineAmount != null && Number.isFinite(input.lineAmount)) {
    return roundMoney(input.lineAmount);
  }
  const qty = input.quantity ?? 1;
  const unit = input.unitAmount ?? 0;
  return roundMoney(qty * unit);
}

export function amountsReconcile(a: number, b: number, toleranceCents = 0): boolean {
  return Math.abs(toCents(a) - toCents(b)) <= toleranceCents;
}
