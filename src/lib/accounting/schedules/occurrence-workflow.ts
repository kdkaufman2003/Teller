import type { SupabaseClient } from "@supabase/supabase-js";
import { recordAuditEvent } from "../audit";
import { assertOccurrenceAction } from "./lifecycle";
import {
  markOccurrenceRequiresReview,
  postScheduleOccurrence,
  reversePostedOccurrence,
} from "./process-due";
import { prepaidJournalLines } from "./prepaid";
import { accrualJournalLines } from "./accrual";
import { deferredRevenueJournalLines } from "./deferred-revenue";

export type OccurrenceDetail = {
  id: string;
  scheduleId: string;
  occurrenceDate: string;
  periodEnd: string;
  amount: number;
  status: string;
  journalEntryId: string | null;
  failureReason: string | null;
  schedule: Record<string, unknown>;
  debitAccountId: string;
  creditAccountId: string;
  debitLabel?: string;
  creditLabel?: string;
};

export function resolveOccurrenceJournalAccounts(schedule: Record<string, unknown>): {
  debitAccountId: string;
  creditAccountId: string;
} {
  const type = schedule.schedule_type as string;
  if (type === "prepaid_expense") {
    return {
      debitAccountId: schedule.expense_account_id as string,
      creditAccountId: schedule.prepaid_account_id as string,
    };
  }
  if (type === "accrued_expense") {
    return {
      debitAccountId: schedule.expense_account_id as string,
      creditAccountId: schedule.liability_account_id as string,
    };
  }
  return {
    debitAccountId: schedule.liability_account_id as string,
    creditAccountId: schedule.revenue_account_id as string,
  };
}

export async function loadOccurrenceDetail(
  supabase: SupabaseClient,
  organizationId: string,
  occurrenceId: string,
): Promise<OccurrenceDetail> {
  const { data, error } = await supabase
    .from("teller_schedule_occurrences")
    .select("*, teller_accounting_schedules(*)")
    .eq("organization_id", organizationId)
    .eq("id", occurrenceId)
    .single();
  if (error || !data) throw new Error(error?.message || "Occurrence not found");

  const schedule = data.teller_accounting_schedules as Record<string, unknown>;
  const accounts = resolveOccurrenceJournalAccounts(schedule);

  return {
    id: data.id as string,
    scheduleId: data.schedule_id as string,
    occurrenceDate: data.occurrence_date as string,
    periodEnd: data.period_end as string,
    amount: Number(data.amount),
    status: data.status as string,
    journalEntryId: (data.journal_entry_id as string) ?? null,
    failureReason: (data.failure_reason as string) ?? null,
    schedule,
    ...accounts,
  };
}

export async function approveScheduleOccurrence(
  supabase: SupabaseClient,
  input: { organizationId: string; occurrenceId: string; actorId?: string | null },
) {
  const detail = await loadOccurrenceDetail(supabase, input.organizationId, input.occurrenceId);
  assertOccurrenceAction(detail.status, "approve");

  await supabase
    .from("teller_schedule_occurrences")
    .update({ status: "approved", approved_by: input.actorId ?? null })
    .eq("id", input.occurrenceId);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "schedule.occurrence_generated",
    resourceKind: "schedule_occurrence",
    resourceId: input.occurrenceId,
    metadata: { approved: true },
  });
}

export async function skipScheduleOccurrence(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    occurrenceId: string;
    reason: string;
    actorId?: string | null;
  },
) {
  const detail = await loadOccurrenceDetail(supabase, input.organizationId, input.occurrenceId);
  assertOccurrenceAction(detail.status, "skip");
  if (!input.reason.trim()) throw new Error("Skip reason is required");

  await supabase
    .from("teller_schedule_occurrences")
    .update({
      status: "skipped",
      metadata: { skip_reason: input.reason.trim() },
    })
    .eq("id", input.occurrenceId);
}

export async function retryFailedOccurrence(
  supabase: SupabaseClient,
  input: { organizationId: string; occurrenceId: string; actorId?: string | null },
) {
  const detail = await loadOccurrenceDetail(supabase, input.organizationId, input.occurrenceId);
  assertOccurrenceAction(detail.status, "retry");

  await supabase
    .from("teller_schedule_occurrences")
    .update({ status: "generated", failure_reason: null })
    .eq("id", input.occurrenceId);
}

export async function postApprovedOccurrence(
  supabase: SupabaseClient,
  input: { organizationId: string; occurrenceId: string; actorId?: string | null },
) {
  const detail = await loadOccurrenceDetail(supabase, input.organizationId, input.occurrenceId);
  assertOccurrenceAction(detail.status, "post");
  return postScheduleOccurrence(supabase, input);
}

export async function reverseOccurrenceWithCanonicalFlow(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    occurrenceId: string;
    reversalDate: string;
    actorId?: string | null;
  },
) {
  const detail = await loadOccurrenceDetail(supabase, input.organizationId, input.occurrenceId);
  assertOccurrenceAction(detail.status, "reverse");
  return reversePostedOccurrence(supabase, input);
}

export function previewOccurrenceJournalLines(
  schedule: Record<string, unknown>,
  amount: number,
): Array<{ account_id: string; debit?: number; credit?: number }> {
  const type = schedule.schedule_type as string;
  const jobId = (schedule.job_id as string) ?? null;
  if (type === "prepaid_expense") {
    return prepaidJournalLines({
      amount,
      expenseAccountId: schedule.expense_account_id as string,
      prepaidAccountId: schedule.prepaid_account_id as string,
      jobId,
    });
  }
  if (type === "accrued_expense") {
    return accrualJournalLines({
      amount,
      expenseAccountId: schedule.expense_account_id as string,
      liabilityAccountId: schedule.liability_account_id as string,
      jobId,
    });
  }
  return deferredRevenueJournalLines({
    amount,
    liabilityAccountId: schedule.liability_account_id as string,
    revenueAccountId: schedule.revenue_account_id as string,
    jobId,
  });
}

export async function markOccurrenceFailedForClosedPeriod(
  supabase: SupabaseClient,
  input: { organizationId: string; occurrenceId: string; reason: string },
) {
  await markOccurrenceRequiresReview(supabase, input);
}
