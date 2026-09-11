import type { PresentationMode } from "@/lib/accounting/presentation-mode";

const OWNER_LABELS: Record<string, string> = {
  sales_tax: "Sales Tax",
  tax_setup: "Tax Setup",
  where_you_collect: "Where You Collect Tax",
  tax_payable: "Tax Payable",
  needs_review: "Needs Review",
};

const ACCOUNTANT_LABELS: Record<string, string> = {
  sales_tax: "Sales Tax",
  tax_setup: "Tax Accounting Setup",
  where_you_collect: "Tax Registration",
  tax_payable: "Sales & Use Tax Payable",
  needs_review: "Needs Review",
  jurisdiction: "Tax Jurisdiction",
  authority: "Tax Authority",
  taxability_rule: "Taxability Rule",
  effective_rate: "Effective Rate",
};

export function taxOwnerLabel(
  key: keyof typeof OWNER_LABELS,
  mode: PresentationMode = "owner",
): string {
  if (mode === "owner") return OWNER_LABELS[key] ?? key;
  return ACCOUNTANT_LABELS[key] ?? OWNER_LABELS[key] ?? key;
}

export function taxAccountantLabel(key: keyof typeof ACCOUNTANT_LABELS): string {
  return ACCOUNTANT_LABELS[key] ?? key;
}
