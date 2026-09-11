import type { PurchaseTaxComparisonResult } from "../purchase/types";
import type { TaxSettingsRecord } from "../types";

export class MissingTaxLiabilityAccountError extends Error {
  constructor(message = "Sales tax payable account is not configured") {
    super(message);
    this.name = "MissingTaxLiabilityAccountError";
  }
}

export class MissingUseTaxExpenseAccountError extends Error {
  constructor(message = "Use tax expense account is not configured") {
    super(message);
    this.name = "MissingUseTaxExpenseAccountError";
  }
}

/** Resolves configured Sales & Use Tax Payable — required when posting positive tax. */
export function resolveSalesTaxPayableAccountId(
  settings: TaxSettingsRecord,
  taxTotal: number,
): string | null {
  const accountId = settings.salesTaxPayableAccountId?.trim();
  if (taxTotal > 0.009 && !accountId) {
    throw new MissingTaxLiabilityAccountError();
  }
  return accountId ?? null;
}

/** Required when use tax debits expense-classified purchase lines. */
export function resolveUseTaxExpenseAccountId(
  settings: TaxSettingsRecord,
  comparison: PurchaseTaxComparisonResult,
  lineKeys: string[],
): string | null {
  const expenseUseTaxDue = comparison.lineResults
    .filter((line) => line.useTaxDue > 0.009 && lineKeys.includes(line.lineKey))
    .filter((line) => line.classification === "expense" || line.classification === "other")
    .reduce((sum, line) => sum + line.useTaxDue, 0);

  const accountId = settings.useTaxExpenseAccountId?.trim();
  if (expenseUseTaxDue > 0.009 && !accountId) {
    throw new MissingUseTaxExpenseAccountError();
  }
  return accountId ?? null;
}
