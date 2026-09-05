import type { TaxLocation, TaxRateRecord } from "./types";

export function roundTaxMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Resolve the effective rate for a jurisdiction on a transaction date. */
export function resolveTaxRate(
  rates: TaxRateRecord[],
  input: {
    jurisdictionKey: string;
    transactionDate: string;
    rateType?: string;
  },
): TaxRateRecord | null {
  const date = input.transactionDate.slice(0, 10);
  const rateType = input.rateType ?? "sales_tax";

  const matches = rates
    .filter((rate) => rate.jurisdictionKey === input.jurisdictionKey)
    .filter((rate) => (rate.rateType ?? "sales_tax") === rateType)
    .filter((rate) => rate.effectiveFrom <= date)
    .filter((rate) => !rate.effectiveTo || rate.effectiveTo >= date)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));

  return matches[0] ?? null;
}

export function taxAmountForLine(taxableAmount: number, ratePercent: number): number {
  return roundTaxMoney((taxableAmount * ratePercent) / 100);
}

export function primaryTransactionLocation(input: {
  jobLocation?: TaxLocation | null;
  businessLocation: TaxLocation;
}): TaxLocation {
  return input.jobLocation?.state ? input.jobLocation : input.businessLocation;
}

export function locationToEvaluationFields(location: TaxLocation) {
  return {
    country: location.country ?? "US",
    state: location.state ?? "",
    county: location.county ?? "",
    city: location.city ?? "",
    postalCode: location.postalCode ?? "",
  };
}
