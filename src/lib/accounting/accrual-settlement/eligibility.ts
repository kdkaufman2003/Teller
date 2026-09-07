import { roundMoney } from "../payment-fees";
import type { EligibleAccrualOccurrence } from "./types";
import { computeOccurrenceSettlementStatus } from "./status";

export type AccrualOccurrenceRow = {
  id: string;
  organization_id: string;
  schedule_id: string;
  occurrence_date: string;
  amount: number;
  status: string;
  journal_entry_id: string | null;
  teller_accounting_schedules: {
    schedule_type: string;
    name: string;
    vendor_party_id: string | null;
    liability_account_id: string | null;
    expense_account_id: string | null;
    status: string;
  };
};

export function assertSameOrganization(organizationId: string, rowOrgId: string): void {
  if (organizationId !== rowOrgId) {
    throw new Error("Cross-organization accrual settlement is not allowed");
  }
}

export function isOccurrenceEligibleForSettlement(
  row: AccrualOccurrenceRow,
  input: {
    organizationId: string;
    billPartyId?: string | null;
    settledAmount?: number;
    applyAmount?: number;
  },
): { eligible: boolean; reason?: string } {
  assertSameOrganization(input.organizationId, row.organization_id);

  const schedule = row.teller_accounting_schedules;
  if (schedule.schedule_type !== "accrued_expense") {
    return { eligible: false, reason: "Not an accrued expense occurrence" };
  }
  if (schedule.status === "cancelled" || schedule.status === "paused") {
    return { eligible: false, reason: "Accrual schedule is not active" };
  }
  if (row.status !== "posted") {
    return { eligible: false, reason: "Accrual occurrence is not posted" };
  }
  if (!row.journal_entry_id) {
    return { eligible: false, reason: "Accrual occurrence has no posted journal" };
  }
  if (!schedule.liability_account_id || !schedule.expense_account_id) {
    return { eligible: false, reason: "Accrual schedule missing liability or expense account" };
  }

  const settled = roundMoney(input.settledAmount ?? 0);
  const remaining = roundMoney(Number(row.amount) - settled);
  const settlementStatus = computeOccurrenceSettlementStatus({
    occurrenceAmount: Number(row.amount),
    settledAmount: settled,
    occurrenceStatus: row.status,
  });
  if (settlementStatus === "settled" || settlementStatus === "reversed") {
    return { eligible: false, reason: "Accrual occurrence is already fully settled or reversed" };
  }

  if (schedule.vendor_party_id && input.billPartyId && schedule.vendor_party_id !== input.billPartyId) {
    return { eligible: false, reason: "Vendor does not match accrual schedule" };
  }

  const applyAmount = roundMoney(input.applyAmount ?? remaining);
  if (applyAmount <= 0) {
    return { eligible: false, reason: "Applied amount must be positive" };
  }
  if (applyAmount > remaining + 0.009) {
    return { eligible: false, reason: "Applied amount exceeds remaining unsettled accrual" };
  }

  return { eligible: true };
}

export function toEligibleOccurrence(
  row: AccrualOccurrenceRow,
  settledAmount: number,
  vendorName?: string | null,
): EligibleAccrualOccurrence {
  const accruedAmount = roundMoney(Number(row.amount));
  const settled = roundMoney(settledAmount);
  const schedule = row.teller_accounting_schedules;
  return {
    occurrenceId: row.id,
    scheduleId: row.schedule_id,
    scheduleName: schedule.name,
    occurrenceDate: row.occurrence_date,
    accruedAmount,
    settledAmount: settled,
    remainingAmount: roundMoney(accruedAmount - settled),
    settlementStatus: computeOccurrenceSettlementStatus({
      occurrenceAmount: accruedAmount,
      settledAmount: settled,
      occurrenceStatus: row.status,
    }),
    vendorPartyId: schedule.vendor_party_id,
    vendorName: vendorName ?? null,
    liabilityAccountId: schedule.liability_account_id as string,
    expenseAccountId: schedule.expense_account_id as string,
    journalEntryId: row.journal_entry_id,
  };
}
