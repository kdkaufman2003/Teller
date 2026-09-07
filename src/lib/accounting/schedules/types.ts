/** Phase 11 schedule types — subledger automation over canonical GL. */

export type ScheduleType = "prepaid_expense" | "accrued_expense" | "deferred_revenue";
export type ScheduleStatus = "draft" | "active" | "paused" | "completed" | "cancelled";
export type OccurrenceStatus =
  | "scheduled"
  | "generated"
  | "approved"
  | "posted"
  | "skipped"
  | "reversed"
  | "failed";

export type RecognitionMethod =
  | "straight_line_monthly"
  | "full_month"
  | "next_full_month"
  | "fixed_amount";

export type RecurringJournalPostMode = "draft_only" | "generate_for_review" | "auto_post";

export type ScheduleRecord = {
  id: string;
  organizationId: string;
  scheduleType: ScheduleType;
  status: ScheduleStatus;
  name: string;
  startDate: string;
  endDate: string | null;
  originalAmount: number;
  remainingAmount: number;
  frequency: "monthly" | "quarterly" | "annually";
  recognitionMethod: RecognitionMethod;
  nextOccurrenceDate: string | null;
  autoReverse: boolean;
  expenseAccountId?: string | null;
  prepaidAccountId?: string | null;
  liabilityAccountId?: string | null;
  revenueAccountId?: string | null;
  jobId?: string | null;
};

export type OccurrenceRecord = {
  id: string;
  scheduleId: string;
  occurrenceDate: string;
  periodEnd: string;
  amount: number;
  status: OccurrenceStatus;
  idempotencyKey: string;
  journalEntryId?: string | null;
};

export function scheduleIdempotencyKey(scheduleId: string, occurrenceDate: string): string {
  return `schedule:${scheduleId}:${occurrenceDate.slice(0, 10)}`;
}

export function recurringBillIdempotencyKey(templateId: string, occurrenceDate: string): string {
  return `recurring_bill:${templateId}:${occurrenceDate.slice(0, 10)}`;
}

export function recurringJournalRunKey(templateId: string, year: number, month: number): string {
  return `recurring_journal:${templateId}:${year}-${String(month).padStart(2, "0")}`;
}

/** Customer deposits (Phase 3) remain the receipt path; deferred revenue schedules recognize from deposit liability. */
export const DEFERRED_REVENUE_V1_NOTE =
  "V1 deferred revenue schedules recognize from customer deposit / deferred liability accounts (subtype deposit). " +
  "Upfront receipts continue via teller_receive_customer_deposit; schedules never double-count applied deposits.";
