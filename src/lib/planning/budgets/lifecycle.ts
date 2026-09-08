import type { BudgetVersionAction, BudgetVersionStatus } from "./types";

const ALLOWED: Record<BudgetVersionStatus, BudgetVersionStatus[]> = {
  draft: ["submitted", "approved", "archived"],
  submitted: ["draft", "approved", "archived"],
  approved: ["locked", "archived"],
  locked: ["archived"],
  archived: [],
};

export function canEditBudgetLines(status: BudgetVersionStatus): boolean {
  return status === "draft" || status === "submitted";
}

export function isImmutableBudgetVersion(status: BudgetVersionStatus): boolean {
  return status === "approved" || status === "locked" || status === "archived";
}

export function assertVersionStatusTransition(
  current: BudgetVersionStatus,
  next: BudgetVersionStatus,
): void {
  if (current === next) return;
  const allowed = ALLOWED[current] ?? [];
  if (!allowed.includes(next)) {
    throw new Error(`Cannot transition budget version from ${current} to ${next}`);
  }
}

export function actionToStatus(action: BudgetVersionAction): BudgetVersionStatus {
  switch (action) {
    case "submit":
      return "submitted";
    case "approve":
      return "approved";
    case "lock":
      return "locked";
    case "archive":
      return "archived";
  }
}

export function assertVersionAction(
  current: BudgetVersionStatus,
  action: BudgetVersionAction,
): void {
  const next = actionToStatus(action);
  assertVersionStatusTransition(current, next);
}

export function assertLinesEditable(status: BudgetVersionStatus): void {
  if (!canEditBudgetLines(status)) {
    throw new Error(`Budget version is not editable (status: ${status})`);
  }
}
