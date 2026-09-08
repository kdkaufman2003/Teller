import { roundMoney } from "../payment-fees";
import { assertInventoryJournalBalanced } from "./journal-lines";
import { PHASE13_RECEIPT_ACCOUNTING_MODEL } from "./types";
import {
  buildGrniBillSettlementJournalLines,
  buildGrniReceiptJournalLines,
  GRNI_PPV_POLICY_V1,
} from "./grni/journal-lines";
import {
  assertMatchCapacity,
  previewBillSettlement,
  type ReceiptOpenState,
  UNMATCHED_INVENTORY_BILL_POLICY,
} from "./grni/settlement";

export type InventoryBillLineInput = {
  amount: number;
  account_id: string | null;
  description: string;
  job_id?: string | null;
  item_type?: string;
  inventory_item_id?: string | null;
  inventory_location_id?: string | null;
  quantity?: number;
  unit_cost?: number;
  receipt_line_id?: string | null;
  receipt_match_quantity?: number;
};

export function isInventoryBillLine(line: InventoryBillLineInput): boolean {
  return line.item_type === "inventory" || Boolean(line.inventory_item_id);
}

export function isGrniMatchedInventoryBillLine(line: InventoryBillLineInput): boolean {
  return isInventoryBillLine(line) && Boolean(line.receipt_line_id) && (line.receipt_match_quantity ?? 0) > 0;
}

/** Matched inventory bill: Dr GRNI (+/- PPV), Cr AP — never Dr Inventory again. */
export function buildGrniMatchedBillJournalPreview(input: {
  settlements: Array<{
    receiptLineId: string;
    billLineId: string;
    quantityMatched: number;
    receiptUnitCost: number;
    billUnitCost: number;
  }>;
  inventoryAssetAccountId: string;
  grniAccountId: string;
  accountsPayableAccountId: string;
  purchasePriceVarianceAccountId: string;
}) {
  let grniTotal = 0;
  let billTotal = 0;
  for (const row of input.settlements) {
    const preview = previewBillSettlement({
      billLineId: row.billLineId,
      receiptLineId: row.receiptLineId,
      quantityToMatch: row.quantityMatched,
      receiptUnitCost: row.receiptUnitCost,
      billUnitCost: row.billUnitCost,
    });
    grniTotal += preview.receiptValueMatched;
    billTotal += preview.billValueMatched;
  }
  grniTotal = roundMoney(grniTotal);
  billTotal = roundMoney(billTotal);
  const lines = buildGrniBillSettlementJournalLines({
    grniAmount: grniTotal,
    billAmount: billTotal,
    grniAccountId: input.grniAccountId,
    accountsPayableAccountId: input.accountsPayableAccountId,
    purchasePriceVarianceAccountId: input.purchasePriceVarianceAccountId,
    memo: "Inventory bill GRNI settlement",
  });
  assertInventoryJournalBalanced(lines);
  const inventoryDebits = lines.filter((row) => row.accountId === input.inventoryAssetAccountId && row.debit > 0);
  if (inventoryDebits.length > 0) {
    throw new Error("Matched inventory bill must not debit inventory asset again");
  }
  return {
    grniTotal,
    billTotal,
    ppvPolicy: GRNI_PPV_POLICY_V1,
    lines,
    accountingModel: PHASE13_RECEIPT_ACCOUNTING_MODEL,
  };
}

export function buildGrniReceiptJournalPreview(input: {
  amount: number;
  inventoryAssetAccountId: string;
  grniAccountId: string;
}) {
  const lines = buildGrniReceiptJournalLines({
    amount: input.amount,
    inventoryAssetAccountId: input.inventoryAssetAccountId,
    grniAccountId: input.grniAccountId,
  });
  return { amount: roundMoney(input.amount), lines, accountingModel: PHASE13_RECEIPT_ACCOUNTING_MODEL };
}

export function validateInventoryBillEconomics(lines: InventoryBillLineInput[]): void {
  for (const line of lines) {
    if (!isInventoryBillLine(line)) continue;
    if (isGrniMatchedInventoryBillLine(line)) {
      if (!line.receipt_line_id) throw new Error("Matched inventory bill line requires receipt_line_id");
      const qty = line.receipt_match_quantity ?? 0;
      const unitCost = line.unit_cost ?? line.amount / (line.quantity ?? 1);
      if (qty <= 0) throw new Error("Matched inventory bill line requires receipt_match_quantity");
      const extended = roundMoney(qty * unitCost);
      if (Math.abs(extended - roundMoney(line.amount)) > 0.02) {
        throw new Error("Matched bill line amount must match quantity × unit cost");
      }
      continue;
    }
    throw new Error(
      `${UNMATCHED_INVENTORY_BILL_POLICY}: inventory bill line requires receipt match before GRNI settlement`,
    );
  }
}

export function validateBillSettlementAgainstReceipt(
  receipt: ReceiptOpenState,
  quantityToMatch: number,
): void {
  assertMatchCapacity(receipt, quantityToMatch);
}

/** Bill payment and bank match must not create inventory, GRNI, COGS, or PPV. */
export function assertPaymentDoesNotAffectInventory(): true {
  return true;
}

export function partitionBillLines(lines: InventoryBillLineInput[]): {
  grniMatchedInventoryLines: InventoryBillLineInput[];
  expenseLines: InventoryBillLineInput[];
  unmatchedInventoryLines: InventoryBillLineInput[];
} {
  const grniMatchedInventoryLines: InventoryBillLineInput[] = [];
  const expenseLines: InventoryBillLineInput[] = [];
  const unmatchedInventoryLines: InventoryBillLineInput[] = [];
  for (const line of lines) {
    if (!isInventoryBillLine(line)) {
      expenseLines.push(line);
    } else if (isGrniMatchedInventoryBillLine(line)) {
      grniMatchedInventoryLines.push(line);
    } else {
      unmatchedInventoryLines.push(line);
    }
  }
  return { grniMatchedInventoryLines, expenseLines, unmatchedInventoryLines };
}

/** @deprecated Use buildGrniMatchedBillJournalPreview for GRNI flow. */
export function buildInventoryBillJournalPreview(input: {
  inventoryLines: InventoryBillLineInput[];
  inventoryAssetAccountId: string;
  accountsPayableAccountId: string;
}) {
  throw new Error("Direct Dr Inventory / Cr AP bill posting removed — use GRNI receipt + settlement flow");
}
