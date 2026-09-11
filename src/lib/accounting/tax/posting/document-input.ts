import { normalizeTaxCategoryKey } from "../categories";
import type { TaxCalculationInput, TaxCalculationLineInput } from "../calculation/types";
import type { TaxLocationInput } from "../types";

export type DocumentLineForTax = {
  id?: string | null;
  lineKey?: string;
  description?: string;
  amount: number;
  account_id?: string | null;
  item_type?: string | null;
  tax_category?: string | null;
  job_id?: string | null;
  cost_classification?: string | null;
  cost_type?: string | null;
  cost_category?: string | null;
};

const ITEM_TYPE_TAX_CATEGORY: Record<string, string> = {
  equipment: "equipment",
  service: "service",
  labor: "labor",
  material: "materials",
  materials: "materials",
  installation: "installation",
  shipping: "shipping",
  maintenance: "maintenance_agreement",
};

export function taxCategoryForDocumentLine(line: DocumentLineForTax): string {
  if (line.tax_category?.trim()) return normalizeTaxCategoryKey(line.tax_category);
  const itemType = (line.item_type ?? "").trim().toLowerCase();
  return ITEM_TYPE_TAX_CATEGORY[itemType] ?? "other";
}

export function buildTaxCalculationInputFromDocument(input: {
  transactionDate: string;
  transactionType: "invoice" | "credit_memo" | "bill";
  partyId?: string | null;
  location: TaxLocationInput;
  lines: DocumentLineForTax[];
}): TaxCalculationInput {
  const calcLines: TaxCalculationLineInput[] = input.lines.map((line, index) => ({
    lineId: line.id ?? null,
    lineKey: line.lineKey ?? line.id ?? String(index),
    description: line.description,
    lineAmount: line.amount,
    taxCategory: taxCategoryForDocumentLine(line),
  }));

  return {
    transactionDate: input.transactionDate,
    transactionType: input.transactionType,
    location: { transactionLocation: input.location },
    customer: input.partyId ? { partyId: input.partyId } : null,
    lines: calcLines,
  };
}
