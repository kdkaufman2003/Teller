export type BudgetHeaderStatus = "active" | "archived";
export type BudgetType = "operating";
export type BudgetVersionStatus = "draft" | "submitted" | "approved" | "locked" | "archived";
export type BudgetBaselineKind = "blank" | "prior_year_actual" | "prior_version";
export type BudgetLineSourceKind =
  | "manual"
  | "import"
  | "clone"
  | "actual_baseline"
  | "prior_version";

export type BudgetVersionAction = "submit" | "approve" | "lock" | "archive";

export type BudgetLineInput = {
  accountId: string;
  periodMonth: string;
  amount: number;
  notes?: string;
};

export type BudgetLineRecord = BudgetLineInput & {
  id?: string;
  budgetVersionId?: string;
  organizationId?: string;
  sourceKind?: BudgetLineSourceKind;
};

export type PlanningAuditEventKind =
  | "budget_created"
  | "budget_created_from_actuals"
  | "budget_copied_forward"
  | "budget_csv_imported"
  | "version_created"
  | "budget_saved"
  | "version_submitted"
  | "version_approved"
  | "version_locked"
  | "version_archived"
  | "version_cloned"
  | "forecast_created"
  | "forecast_version_created"
  | "forecast_initialized_from_budget"
  | "forecast_saved"
  | "forecast_published"
  | "forecast_revision_created"
  | "forecast_archived"
  | "forecast_assumption_saved"
  | "forecast_assumption_deleted"
  | "forecast_refreshed"
  | "forecast_override_cleared"
  | "cash_forecast_run_created"
  | "cash_manual_adjustment_created"
  | "cash_manual_adjustment_updated"
  | "cash_manual_adjustment_deleted"
  | "cash_timing_settings_updated"
  | "scenario_created"
  | "scenario_updated"
  | "scenario_archived";

export type BudgetCsvImportMode = "replace" | "merge";

export const MAX_BULK_LINES = 5000;
