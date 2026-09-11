import type { TaxRoundingPolicy, TaxSettingsRecord, TaxSetupStatus } from "./types";

export type TaxSettingsRow = {
  organization_id: string;
  sales_tax_payable_account_id: string | null;
  use_tax_expense_account_id: string | null;
  rounding_policy: TaxRoundingPolicy;
  setup_status: TaxSetupStatus;
  tax_inclusive_supported: boolean;
  metadata: Record<string, unknown>;
  updated_at: string;
  updated_by: string | null;
};

export const DEFAULT_TAX_SETTINGS: Omit<TaxSettingsRecord, "organizationId"> = {
  salesTaxPayableAccountId: null,
  useTaxExpenseAccountId: null,
  roundingPolicy: "per_line",
  setupStatus: "not_configured",
  taxInclusiveSupported: false,
};

export function parseTaxSettingsRow(row: TaxSettingsRow | null, organizationId: string): TaxSettingsRecord {
  if (!row) {
    return { organizationId, ...DEFAULT_TAX_SETTINGS };
  }
  return {
    organizationId: row.organization_id,
    salesTaxPayableAccountId: row.sales_tax_payable_account_id,
    useTaxExpenseAccountId: row.use_tax_expense_account_id,
    roundingPolicy: row.rounding_policy,
    setupStatus: row.setup_status,
    taxInclusiveSupported: row.tax_inclusive_supported,
  };
}

export function taxSettingsToRow(
  settings: TaxSettingsRecord,
  updatedBy?: string | null,
): Omit<TaxSettingsRow, "updated_at"> {
  return {
    organization_id: settings.organizationId,
    sales_tax_payable_account_id: settings.salesTaxPayableAccountId ?? null,
    use_tax_expense_account_id: settings.useTaxExpenseAccountId ?? null,
    rounding_policy: settings.roundingPolicy,
    setup_status: settings.setupStatus,
    tax_inclusive_supported: settings.taxInclusiveSupported,
    metadata: {},
    updated_by: updatedBy ?? null,
  };
}
