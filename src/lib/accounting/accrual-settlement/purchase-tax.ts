import { roundMoney } from "../payment-fees";

export type PurchaseTaxTreatment =
  | "nonrecoverable_expense"
  | "nonrecoverable_asset"
  | "recoverable_input_tax";

export type PurchaseTaxTarget = {
  accountId: string;
  amount: number;
  accountType?: string | null;
  /** When true and recoverableInputTaxAccountId is configured, tax uses input-tax asset. */
  recoverableInputTax?: boolean;
};

export type PurchaseTaxAllocation = {
  accountId: string;
  amount: number;
  treatment: PurchaseTaxTreatment;
  memo?: string;
};

/**
 * V1 vendor purchase tax: never post to sales-tax-payable liability.
 * Nonrecoverable tax is capitalized into the related expense/asset account.
 * Recoverable input tax uses a dedicated asset account only when configured.
 */
export function allocateVendorPurchaseTax(input: {
  taxAmount: number;
  targets: PurchaseTaxTarget[];
  recoverableInputTaxAccountId?: string | null;
}): PurchaseTaxAllocation[] {
  const taxAmount = roundMoney(input.taxAmount);
  if (taxAmount <= 0) return [];

  const eligible = input.targets.filter((target) => target.amount > 0 && target.accountId);
  if (!eligible.length) {
    throw new Error("Purchase tax requires at least one expense or asset line to absorb the cost");
  }

  const baseTotal = roundMoney(eligible.reduce((sum, target) => sum + target.amount, 0));
  const allocations: PurchaseTaxAllocation[] = [];
  let assigned = 0;

  for (let index = 0; index < eligible.length; index += 1) {
    const target = eligible[index];
    const isAsset = target.accountType === "asset" || target.accountType === "fixed_asset";
    const recoverable =
      Boolean(input.recoverableInputTaxAccountId) &&
      Boolean(target.recoverableInputTax);

    let share: number;
    if (index === eligible.length - 1) {
      share = roundMoney(taxAmount - assigned);
    } else {
      share = roundMoney((target.amount / baseTotal) * taxAmount);
      assigned = roundMoney(assigned + share);
    }

    if (share <= 0) continue;

    if (recoverable && input.recoverableInputTaxAccountId) {
      allocations.push({
        accountId: input.recoverableInputTaxAccountId,
        amount: share,
        treatment: "recoverable_input_tax",
        memo: "Recoverable input tax",
      });
    } else {
      allocations.push({
        accountId: target.accountId,
        amount: share,
        treatment: isAsset ? "nonrecoverable_asset" : "nonrecoverable_expense",
        memo: isAsset ? "Nonrecoverable purchase tax (asset cost)" : "Nonrecoverable purchase tax (expense cost)",
      });
    }
  }

  return allocations;
}

/** Merge purchase tax into expense/asset debits for journal presentation. */
export function mergePurchaseTaxIntoTargets(
  targets: PurchaseTaxTarget[],
  taxAllocations: PurchaseTaxAllocation[],
): Array<{ accountId: string; amount: number; memo?: string }> {
  const merged = new Map<string, number>();
  for (const target of targets) {
    if (target.amount <= 0) continue;
    merged.set(target.accountId, roundMoney((merged.get(target.accountId) ?? 0) + target.amount));
  }
  for (const tax of taxAllocations) {
    merged.set(tax.accountId, roundMoney((merged.get(tax.accountId) ?? 0) + tax.amount));
  }
  return [...merged.entries()].map(([accountId, amount]) => ({ accountId, amount }));
}

export function purchaseTaxUsesSalesTaxPayable(): false {
  return false;
}
