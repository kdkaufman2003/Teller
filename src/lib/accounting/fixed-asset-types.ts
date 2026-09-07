export type FixedAssetStatus = "draft" | "active" | "disposed";
export type FixedAssetAcquisitionMode = "linked" | "new_acquisition" | "opening_balance";
export type DepreciationConvention = "full_month" | "next_full_month";
export type DepreciationMethod = "straight_line";
export type DepreciationEntryStatus = "posted" | "reversed";
export type DisposalType = "sold" | "retired" | "written_off" | "lost" | "other";

export type AccountLookup = {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype?: string | null;
};

export type FixedAssetRecord = {
  id: string;
  organization_id: string;
  asset_number: string;
  name: string;
  description: string;
  category_id: string | null;
  status: FixedAssetStatus;
  acquisition_mode: FixedAssetAcquisitionMode;
  acquisition_date: string | null;
  placed_in_service_date: string | null;
  vendor_party_id: string | null;
  purchase_document_id: string | null;
  purchase_document_line_id: string | null;
  acquisition_journal_entry_id: string | null;
  capitalization_journal_entry_id: string | null;
  opening_accum_depr_journal_entry_id: string | null;
  original_cost: number;
  salvage_value: number;
  useful_life_months: number;
  depreciation_method: DepreciationMethod;
  depreciation_start_date: string | null;
  asset_account_id: string | null;
  accumulated_depreciation_account_id: string | null;
  depreciation_expense_account_id: string | null;
  gain_account_id: string | null;
  loss_account_id: string | null;
  disposal_date: string | null;
  disposal_type: DisposalType | null;
  disposal_proceeds: number;
  disposal_journal_entry_id: string | null;
  activated_at: string | null;
};

export type DepreciationScheduleLine = {
  periodYear: number;
  periodMonth: number;
  periodStartDate: string;
  beginningBookValue: number;
  depreciationAmount: number;
  accumulatedDepreciation: number;
  endingBookValue: number;
  isFinalPeriod: boolean;
};

export type GlReconciliationSlice = {
  glActivity: number;
  subledgerAttributed: number;
  unassigned: number;
  difference: number;
};
