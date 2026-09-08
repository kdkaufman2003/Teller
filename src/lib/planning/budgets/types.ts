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
  | "version_created"
  | "budget_saved"
  | "version_submitted"
  | "version_approved"
  | "version_locked"
  | "version_archived"
  | "version_cloned";

export const MAX_BULK_LINES = 5000;
