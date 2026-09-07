import { asNumber } from "@/lib/format";
import { roundMoney } from "./payment-fees";

export type SalesTaxSummaryRow = {
  period: string;
  jurisdiction: string;
  taxableSales: number;
  nonTaxableSales: number;
  taxCollected: number;
  creditsRefunds: number;
  netLiability: number;
  configurationReviewRequired: boolean;
};

export type SalesTaxSummaryReport = {
  periodStart: string | null;
  periodEnd: string;
  rows: SalesTaxSummaryRow[];
  salesTaxPayableGlBalance: number;
  reportedNetLiability: number;
  difference: number;
  configurationReviewRequired: boolean;
  filingEnabled: false;
};

export type InvoiceTaxLine = {
  issueDate: string;
  subtotal: number;
  tax: number;
  jurisdiction: string | null;
  taxMode: string | null;
  status: string;
  kind: string;
};

export function buildSalesTaxSummary(input: {
  invoices: InvoiceTaxLine[];
  creditMemos?: InvoiceTaxLine[];
  periodStart: string | null;
  periodEnd: string;
  salesTaxPayableGlBalance: number;
  orgTaxMode?: string | null;
}): SalesTaxSummaryReport {
  const inPeriod = (date: string) => {
    const d = date.slice(0, 10);
    if (input.periodStart && d < input.periodStart) return false;
    if (d > input.periodEnd) return false;
    return true;
  };

  const bucketMap = new Map<string, SalesTaxSummaryRow>();

  for (const inv of input.invoices) {
    if (inv.kind !== "invoice" || inv.status === "void" || inv.status === "draft") continue;
    if (!inPeriod(inv.issueDate)) continue;

    const jurisdiction = inv.jurisdiction?.trim() || "Unconfigured";
    const configReview =
      !inv.jurisdiction ||
      input.orgTaxMode === "jurisdiction" ||
      jurisdiction === "Unconfigured";

    const row =
      bucketMap.get(jurisdiction) ??
      ({
        period: input.periodEnd.slice(0, 7),
        jurisdiction,
        taxableSales: 0,
        nonTaxableSales: 0,
        taxCollected: 0,
        creditsRefunds: 0,
        netLiability: 0,
        configurationReviewRequired: configReview,
      } satisfies SalesTaxSummaryRow);

    const subtotal = asNumber(inv.subtotal);
    const tax = asNumber(inv.tax);
    if (tax > 0.009) row.taxableSales = roundMoney(row.taxableSales + subtotal);
    else row.nonTaxableSales = roundMoney(row.nonTaxableSales + subtotal);
    row.taxCollected = roundMoney(row.taxCollected + tax);
    if (configReview) row.configurationReviewRequired = true;
    bucketMap.set(jurisdiction, row);
  }

  for (const cm of input.creditMemos ?? []) {
    if (cm.kind !== "credit_memo" || cm.status === "void") continue;
    if (!inPeriod(cm.issueDate)) continue;
    const jurisdiction = cm.jurisdiction?.trim() || "Unconfigured";
    const row = bucketMap.get(jurisdiction);
    if (!row) continue;
    row.creditsRefunds = roundMoney(row.creditsRefunds + asNumber(cm.tax));
  }

  const rows = [...bucketMap.values()].map((row) => ({
    ...row,
    netLiability: roundMoney(row.taxCollected - row.creditsRefunds),
  }));

  const reportedNetLiability = roundMoney(rows.reduce((s, r) => s + r.netLiability, 0));
  const difference = roundMoney(reportedNetLiability - input.salesTaxPayableGlBalance);

  return {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    rows,
    salesTaxPayableGlBalance: roundMoney(input.salesTaxPayableGlBalance),
    reportedNetLiability,
    difference,
    configurationReviewRequired:
      rows.some((r) => r.configurationReviewRequired) || input.orgTaxMode === "jurisdiction",
    filingEnabled: false,
  };
}
