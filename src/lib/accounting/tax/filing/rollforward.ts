import { roundMoney } from "../../payment-fees";
import type { TaxTransactionType } from "../types";
import type { TaxLiabilityRollforwardLine } from "./types";

export type TaxTransactionForRollforward = {
  id: string;
  transactionType: TaxTransactionType;
  transactionDate: string;
  taxAmount: number;
  determinationStatus: string;
  postedJournalEntryId?: string | null;
  primaryJurisdictionKey?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type SignedTaxAmount = {
  salesTaxAccrued: number;
  useTaxAccrued: number;
  salesTaxCredits: number;
  useTaxReversals: number;
  taxAdjustments: number;
  authorityPayments: number;
  netAmount: number;
};

export function signedTaxAmountForTransaction(tx: TaxTransactionForRollforward): SignedTaxAmount {
  const amount = roundMoney(Math.abs(tx.taxAmount));
  const zero: SignedTaxAmount = {
    salesTaxAccrued: 0,
    useTaxAccrued: 0,
    salesTaxCredits: 0,
    useTaxReversals: 0,
    taxAdjustments: 0,
    authorityPayments: 0,
    netAmount: 0,
  };
  if (amount <= 0.009) return zero;

  switch (tx.transactionType) {
    case "sales_tax_collected":
      return { ...zero, salesTaxAccrued: amount, netAmount: amount };
    case "sales_tax_reversed":
    case "sales_tax_refunded":
      return { ...zero, salesTaxCredits: amount, netAmount: -amount };
    case "use_tax_accrued":
      return { ...zero, useTaxAccrued: amount, netAmount: amount };
    case "tax_adjustment": {
      const metadata = (tx.metadata ?? {}) as Record<string, unknown>;
      const purchaseReversal = Boolean(
        metadata.purchaseTaxReversal || metadata.reversesTaxTransactionId,
      );
      if (purchaseReversal) {
        return { ...zero, useTaxReversals: amount, netAmount: -amount };
      }
      if (metadata.authorityPaymentReversal) {
        return { ...zero, authorityPayments: -amount, netAmount: amount };
      }
      if (metadata.manualAdjustment && metadata.adjustmentDirection === "increase_liability") {
        return { ...zero, taxAdjustments: amount, netAmount: amount };
      }
      if (metadata.manualAdjustment && metadata.adjustmentDirection === "decrease_liability") {
        return { ...zero, taxAdjustments: amount, netAmount: -amount };
      }
      return { ...zero, taxAdjustments: amount, netAmount: -amount };
    }
    case "authority_payment":
      return { ...zero, authorityPayments: amount, netAmount: -amount };
    default:
      return zero;
  }
}

export function aggregateRollforward(transactions: TaxTransactionForRollforward[]): {
  totals: SignedTaxAmount;
  lines: TaxLiabilityRollforwardLine[];
} {
  const totals: SignedTaxAmount = {
    salesTaxAccrued: 0,
    useTaxAccrued: 0,
    salesTaxCredits: 0,
    useTaxReversals: 0,
    taxAdjustments: 0,
    authorityPayments: 0,
    netAmount: 0,
  };

  for (const tx of transactions) {
    const signed = signedTaxAmountForTransaction(tx);
    totals.salesTaxAccrued = roundMoney(totals.salesTaxAccrued + signed.salesTaxAccrued);
    totals.useTaxAccrued = roundMoney(totals.useTaxAccrued + signed.useTaxAccrued);
    totals.salesTaxCredits = roundMoney(totals.salesTaxCredits + signed.salesTaxCredits);
    totals.useTaxReversals = roundMoney(totals.useTaxReversals + signed.useTaxReversals);
    totals.taxAdjustments = roundMoney(totals.taxAdjustments + signed.taxAdjustments);
    totals.authorityPayments = roundMoney(totals.authorityPayments + signed.authorityPayments);
    totals.netAmount = roundMoney(totals.netAmount + signed.netAmount);
  }

  const lines: TaxLiabilityRollforwardLine[] = [
    {
      category: "sales_tax_accrued",
      amount: totals.salesTaxAccrued,
      transactionCount: transactions.filter((tx) => tx.transactionType === "sales_tax_collected").length,
    },
    {
      category: "use_tax_accrued",
      amount: totals.useTaxAccrued,
      transactionCount: transactions.filter((tx) => tx.transactionType === "use_tax_accrued").length,
    },
    {
      category: "sales_tax_reversed",
      amount: totals.salesTaxCredits,
      transactionCount: transactions.filter((tx) =>
        ["sales_tax_reversed", "sales_tax_refunded"].includes(tx.transactionType),
      ).length,
    },
    {
      category: "use_tax_reversed",
      amount: totals.useTaxReversals,
      transactionCount: transactions.filter(
        (tx) => tx.transactionType === "tax_adjustment" && signedTaxAmountForTransaction(tx).useTaxReversals > 0,
      ).length,
    },
    {
      category: "tax_adjustment",
      amount: totals.taxAdjustments,
      transactionCount: transactions.filter(
        (tx) => tx.transactionType === "tax_adjustment" && signedTaxAmountForTransaction(tx).taxAdjustments > 0,
      ).length,
    },
    {
      category: "authority_payment",
      amount: totals.authorityPayments,
      transactionCount: transactions.filter((tx) => tx.transactionType === "authority_payment").length,
    },
    {
      category: "ending_subledger_liability",
      amount: totals.netAmount,
      transactionCount: transactions.length,
    },
  ];

  return { totals, lines };
}

/** Vendor-charged purchase tax must never enter use-tax liability rollforward. */
export function includesVendorTaxInUseTaxLiability(transactions: TaxTransactionForRollforward[]): boolean {
  return transactions.some(
    (tx) =>
      tx.transactionType === "use_tax_accrued" &&
      typeof tx.metadata === "object" &&
      tx.metadata !== null &&
      Boolean((tx.metadata as { vendorTaxChargedDocument?: number }).vendorTaxChargedDocument) &&
      roundMoney((tx.metadata as { vendorTax?: number }).vendorTax ?? 0) > 0 &&
      roundMoney((tx.metadata as { useTaxDue?: number }).useTaxDue ?? 0) <= 0.009,
  );
}
