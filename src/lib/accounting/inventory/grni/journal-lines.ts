import { roundMoney } from "../../payment-fees";
import type { InventoryJournalLine } from "../journal-lines";
import { assertInventoryJournalBalanced } from "../journal-lines";

/** Inventory receipt before vendor bill: Dr Inventory Asset, Cr GRNI. */
export function buildGrniReceiptJournalLines(input: {
  amount: number;
  inventoryAssetAccountId: string;
  grniAccountId: string;
  memo?: string;
}): InventoryJournalLine[] {
  const amount = roundMoney(input.amount);
  const lines: InventoryJournalLine[] = [
    {
      accountId: input.inventoryAssetAccountId,
      debit: amount,
      credit: 0,
      memo: input.memo ?? "Inventory receipt (GRNI)",
    },
    {
      accountId: input.grniAccountId,
      debit: 0,
      credit: amount,
      memo: input.memo ?? "Inventory receipt (GRNI)",
    },
  ];
  assertInventoryJournalBalanced(lines);
  return lines;
}

/** Vendor bill matching received goods: Dr GRNI, Cr AP (no duplicate inventory). */
export function buildGrniBillSettlementJournalLines(input: {
  grniAmount: number;
  billAmount: number;
  grniAccountId: string;
  accountsPayableAccountId: string;
  purchasePriceVarianceAccountId: string;
  memo?: string;
}): InventoryJournalLine[] {
  const grniAmount = roundMoney(input.grniAmount);
  const billAmount = roundMoney(input.billAmount);
  const variance = roundMoney(billAmount - grniAmount);
  const lines: InventoryJournalLine[] = [
    {
      accountId: input.grniAccountId,
      debit: grniAmount,
      credit: 0,
      memo: input.memo ?? "GRNI bill settlement",
    },
  ];
  if (Math.abs(variance) > 0.009) {
    if (variance > 0) {
      lines.push({
        accountId: input.purchasePriceVarianceAccountId,
        debit: variance,
        credit: 0,
        memo: input.memo ?? "Purchase price variance",
      });
    } else {
      lines.push({
        accountId: input.purchasePriceVarianceAccountId,
        debit: 0,
        credit: Math.abs(variance),
        memo: input.memo ?? "Purchase price variance",
      });
    }
  }
  lines.push({
    accountId: input.accountsPayableAccountId,
    debit: 0,
    credit: billAmount,
    memo: input.memo ?? "GRNI bill settlement",
  });
  assertInventoryJournalBalanced(lines);
  return lines;
}

/** Unbilled vendor return before invoice: Dr GRNI, Cr Inventory. */
export function buildUnbilledVendorReturnJournalLines(input: {
  amount: number;
  grniAccountId: string;
  inventoryAssetAccountId: string;
  memo?: string;
}): InventoryJournalLine[] {
  const amount = roundMoney(input.amount);
  const lines: InventoryJournalLine[] = [
    {
      accountId: input.grniAccountId,
      debit: amount,
      credit: 0,
      memo: input.memo ?? "Unbilled vendor return",
    },
    {
      accountId: input.inventoryAssetAccountId,
      debit: 0,
      credit: amount,
      memo: input.memo ?? "Unbilled vendor return",
    },
  ];
  assertInventoryJournalBalanced(lines);
  return lines;
}

/** Receipt reversal when unbilled: Dr GRNI, Cr Inventory. */
export function buildGrniReceiptReversalJournalLines(input: {
  amount: number;
  grniAccountId: string;
  inventoryAssetAccountId: string;
  memo?: string;
}): InventoryJournalLine[] {
  const amount = roundMoney(input.amount);
  const lines: InventoryJournalLine[] = [
    {
      accountId: input.grniAccountId,
      debit: amount,
      credit: 0,
      memo: input.memo ?? "Receipt reversal",
    },
    {
      accountId: input.inventoryAssetAccountId,
      debit: 0,
      credit: amount,
      memo: input.memo ?? "Receipt reversal",
    },
  ];
  assertInventoryJournalBalanced(lines);
  return lines;
}

/** Same-day receipt + bill net: Dr Inventory, Cr AP when GRNI nets to zero. */
export function assertSameDayNetEconomics(input: {
  receiptAmount: number;
  billSettlementAmount: number;
  inventoryAssetDebit: number;
  apCredit: number;
}): boolean {
  const netInventory = roundMoney(input.receiptAmount);
  const netAp = roundMoney(input.billSettlementAmount);
  return (
    Math.abs(input.inventoryAssetDebit - netInventory) <= 0.009 &&
    Math.abs(input.apCredit - netAp) <= 0.009
  );
}

/** V1 PPV policy: variance posts to PPV account; no automatic capitalization to inventory/COGS. */
export const GRNI_PPV_POLICY_V1 =
  "purchase_price_variance_account_deterministic_no_auto_capitalization_v1" as const;
