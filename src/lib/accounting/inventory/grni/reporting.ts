import { roundMoney } from "../../payment-fees";
import { computeOpenReceiptQuantity, computeOpenReceiptValue, type ReceiptOpenState } from "./settlement";

export type GrniAgingBucket = "current" | "1_30" | "31_60" | "61_90" | "90_plus";

export type GrniAgingRow = {
  vendorId: string;
  vendorName: string;
  purchaseOrderId: string;
  receiptDate: string;
  itemSku: string;
  quantityReceived: number;
  quantityBilled: number;
  quantityOpen: number;
  receiptValue: number;
  matchedValue: number;
  openGrni: number;
  ageDays: number;
  bucket: GrniAgingBucket;
};

export function classifyGrniAgingBucket(ageDays: number): GrniAgingBucket {
  if (ageDays <= 0) return "current";
  if (ageDays <= 30) return "1_30";
  if (ageDays <= 60) return "31_60";
  if (ageDays <= 90) return "61_90";
  return "90_plus";
}

export function buildGrniAgingReport(
  rows: Array<
    ReceiptOpenState & {
      vendorId: string;
      vendorName: string;
      purchaseOrderId: string;
      receiptDate: string;
      itemSku: string;
    }
  >,
  asOfDate: string,
): GrniAgingRow[] {
  const asOf = new Date(asOfDate);
  return rows
    .map((row) => {
      const openGrni = computeOpenReceiptValue(row);
      if (openGrni <= 0.009) return null;
      const receiptDate = new Date(row.receiptDate);
      const ageDays = Math.max(0, Math.floor((asOf.getTime() - receiptDate.getTime()) / 86400000));
      return {
        vendorId: row.vendorId,
        vendorName: row.vendorName,
        purchaseOrderId: row.purchaseOrderId,
        receiptDate: row.receiptDate,
        itemSku: row.itemSku,
        quantityReceived: roundMoney(row.quantityReceived),
        quantityBilled: roundMoney(row.quantityMatched),
        quantityOpen: computeOpenReceiptQuantity(row),
        receiptValue: roundMoney(row.receiptValue),
        matchedValue: roundMoney(row.valueMatched),
        openGrni,
        ageDays,
        bucket: classifyGrniAgingBucket(ageDays),
      };
    })
    .filter((row): row is GrniAgingRow => row != null)
    .sort((a, b) => b.ageDays - a.ageDays);
}

export type PurchasePriceVarianceRow = {
  vendorId: string;
  purchaseOrderId: string;
  receiptLineId: string;
  billLineId: string;
  itemSku: string;
  receiptUnitCost: number;
  billUnitCost: number;
  quantityMatched: number;
  receiptValue: number;
  billValue: number;
  variance: number;
};

export function buildPurchasePriceVarianceReport(
  allocations: Array<{
    vendorId: string;
    purchaseOrderId: string;
    receiptLineId: string;
    billLineId: string;
    itemSku: string;
    receiptUnitCost: number;
    billUnitCost: number;
    quantityMatched: number;
    receiptValueMatched: number;
    billValueMatched: number;
    varianceAmount: number;
    reversed?: boolean;
  }>,
): PurchasePriceVarianceRow[] {
  return allocations
    .filter((row) => !row.reversed && Math.abs(row.varianceAmount) > 0.009)
    .map((row) => ({
      vendorId: row.vendorId,
      purchaseOrderId: row.purchaseOrderId,
      receiptLineId: row.receiptLineId,
      billLineId: row.billLineId,
      itemSku: row.itemSku,
      receiptUnitCost: roundMoney(row.receiptUnitCost),
      billUnitCost: roundMoney(row.billUnitCost),
      quantityMatched: roundMoney(row.quantityMatched),
      receiptValue: roundMoney(row.receiptValueMatched),
      billValue: roundMoney(row.billValueMatched),
      variance: roundMoney(row.varianceAmount),
    }));
}

export type AccountantGrniPackage = {
  aging: GrniAgingRow[];
  openGrniTotal: number;
  ppvTotal: number;
  reconciliationDifference: number;
};

export function buildAccountantGrniPackage(input: {
  aging: GrniAgingRow[];
  ppvRows: PurchasePriceVarianceRow[];
  reconciliationDifference: number;
}): AccountantGrniPackage {
  return {
    aging: input.aging,
    openGrniTotal: roundMoney(input.aging.reduce((sum, row) => sum + row.openGrni, 0)),
    ppvTotal: roundMoney(input.ppvRows.reduce((sum, row) => sum + row.variance, 0)),
    reconciliationDifference: roundMoney(input.reconciliationDifference),
  };
}
