import { roundMoney } from "@/lib/accounting/payment-fees";
import { taxAmountFromBasis } from "./rates";

/** Tax-exclusive: basis is pre-tax amount. */
export function splitTaxExclusive(basis: number, ratePercent: number): {
  basis: number;
  taxAmount: number;
  total: number;
} {
  const taxAmount = taxAmountFromBasis(basis, ratePercent);
  return { basis: roundMoney(basis), taxAmount, total: roundMoney(basis + taxAmount) };
}

/** Tax-inclusive: total includes tax; derive basis and tax from combined total. */
export function splitTaxInclusive(totalIncludingTax: number, ratePercent: number): {
  basis: number;
  taxAmount: number;
  total: number;
} {
  if (totalIncludingTax <= 0 || ratePercent <= 0) {
    return { basis: roundMoney(totalIncludingTax), taxAmount: 0, total: roundMoney(totalIncludingTax) };
  }
  const basis = roundMoney(totalIncludingTax / (1 + ratePercent / 100));
  const taxAmount = roundMoney(totalIncludingTax - basis);
  return { basis, taxAmount, total: roundMoney(totalIncludingTax) };
}
