import type { TaxCalculationResult } from "../calculation/types";

export type PurchaseLineClassification = "expense" | "inventory" | "fixed_asset" | "other";

export type PurchaseTaxLineStatus =
  | "fully_taxed"
  | "use_tax_due"
  | "non_taxable"
  | "exempt"
  | "vendor_tax_overage"
  | "needs_review";

export type PurchaseTaxLineComparison = {
  lineKey: string;
  lineId?: string | null;
  taxableBasis: number;
  requiredTax: number;
  vendorTax: number;
  useTaxDue: number;
  vendorTaxOverage: number;
  status: PurchaseTaxLineStatus;
  classification: PurchaseLineClassification;
  components: Array<{
    jurisdictionKey: string;
    requiredTax: number;
    vendorTax: number;
    useTaxDue: number;
  }>;
};

export type PurchaseTaxComparisonResult = {
  status: "resolved" | "needs_review" | "vendor_tax_overage";
  requiredTaxTotal: number;
  vendorTaxTotal: number;
  useTaxDueTotal: number;
  vendorTaxOverageTotal: number;
  lineResults: PurchaseTaxLineComparison[];
  reasonCodes: string[];
  warnings: string[];
};

export type PurchaseTaxPostingInput = {
  calculation: TaxCalculationResult;
  vendorTaxCharged: number;
  vendorTaxByLine?: Record<string, number>;
};
