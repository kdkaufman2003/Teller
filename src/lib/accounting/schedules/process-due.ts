import type { SupabaseClient } from "@supabase/supabase-js";
import { postJournal } from "../post";
import { recordAuditEvent } from "../audit";
import { roundMoney } from "../payment-fees";
import { endOfMonth } from "../periods";
import { accrualJournalLines, accrualReversalLines } from "./accrual";
import { deferredRevenueJournalLines } from "./deferred-revenue";
import { prepaidJournalLines, validatePrepaidRecognition, nextRemainingAfterRecognition } from "./prepaid";
import { scheduleIdempotencyKey, type OccurrenceStatus } from "./types";

export type ProcessDueResult = {
  processed: number;
  skipped: number;
  failed: number;
  results: Array<{ occurrenceId: string; status: OccurrenceStatus; detail?: string }>;
};

export async function claimScheduleOccurrence(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    scheduleId: string;
    occurrenceDate: string;
    periodEnd: string;
    amount: number;
  },
) {
  const idempotencyKey = scheduleIdempotencyKey(input.scheduleId, input.occurrenceDate);
  const { data: existing } = await supabase
    .from("teller_schedule_occurrences")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (existing) return { occurrence: existing, duplicate: true };

  const { data, error } = await supabase
    .from("teller_schedule_occurrences")
    .insert({
      organization_id: input.organizationId,
      schedule_id: input.scheduleId,
      occurrence_date: input.occurrenceDate.slice(0, 10),
      period_end: input.periodEnd.slice(0, 10),
      amount: roundMoney(input.amount),
      status: "scheduled",
      idempotency_key: idempotencyKey,
    })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") {
      const { data: raced } = await supabase
        .from("teller_schedule_occurrences")
        .select("*")
        .eq("organization_id", input.organizationId)
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();
      return { occurrence: raced, duplicate: true };
    }
    throw new Error(error.message);
  }
  return { occurrence: data, duplicate: false };
}

export async function postScheduleOccurrence(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    occurrenceId: string;
    actorId?: string | null;
  },
): Promise<{ journalEntryId: string }> {
  const { data: occurrence, error } = await supabase
    .from("teller_schedule_occurrences")
    .select("*, teller_accounting_schedules(*)")
    .eq("organization_id", input.organizationId)
    .eq("id", input.occurrenceId)
    .single();
  if (error || !occurrence) throw new Error(error?.message || "Occurrence not found");
  if (occurrence.status === "posted" && occurrence.journal_entry_id) {
    return { journalEntryId: occurrence.journal_entry_id as string };
  }
  if (occurrence.status === "reversed") throw new Error("Occurrence was reversed");

  const schedule = occurrence.teller_accounting_schedules as Record<string, unknown>;
  const scheduleType = schedule.schedule_type as string;
  const amount = roundMoney(Number(occurrence.amount));

  let lines: Array<Record<string, unknown>>;
  if (scheduleType === "prepaid_expense") {
    validatePrepaidRecognition(
      {
        originalAmount: Number(schedule.original_amount),
        remainingAmount: Number(schedule.remaining_amount),
      },
      amount,
    );
    lines = prepaidJournalLines({
      amount,
      expenseAccountId: schedule.expense_account_id as string,
      prepaidAccountId: schedule.prepaid_account_id as string,
      jobId: (schedule.job_id as string) ?? null,
    });
  } else if (scheduleType === "accrued_expense") {
    lines = accrualJournalLines({
      amount,
      expenseAccountId: schedule.expense_account_id as string,
      liabilityAccountId: schedule.liability_account_id as string,
      jobId: (schedule.job_id as string) ?? null,
    });
  } else if (scheduleType === "deferred_revenue") {
    lines = deferredRevenueJournalLines({
      amount,
      liabilityAccountId: schedule.liability_account_id as string,
      revenueAccountId: schedule.revenue_account_id as string,
      jobId: (schedule.job_id as string) ?? null,
    });
  } else {
    throw new Error(`Unsupported schedule type ${scheduleType}`);
  }

  const entryId = await postJournal(supabase, {
    organizationId: input.organizationId,
    entryDate: occurrence.occurrence_date as string,
    memo: `${schedule.name} schedule recognition`,
    sourceKind: `schedule-${scheduleType}`,
    sourceId: occurrence.id as string,
    lines: lines as Parameters<typeof postJournal>[1]["lines"],
  });

  const remaining =
    scheduleType === "prepaid_expense" || scheduleType === "deferred_revenue"
      ? nextRemainingAfterRecognition(Number(schedule.remaining_amount), amount)
      : Number(schedule.remaining_amount);

  await supabase
    .from("teller_schedule_occurrences")
    .update({
      status: "posted",
      journal_entry_id: entryId,
      posted_at: new Date().toISOString(),
      posted_by: input.actorId ?? null,
    })
    .eq("id", occurrence.id);

  const nextStatus = remaining <= 0 ? "completed" : (schedule.status as string);
  await supabase
    .from("teller_accounting_schedules")
    .update({
      remaining_amount: remaining,
      status: nextStatus === "completed" ? "completed" : schedule.status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", schedule.id);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "schedule.occurrence_posted",
    resourceKind: "schedule_occurrence",
    resourceId: occurrence.id as string,
    metadata: { journalEntryId: entryId, scheduleId: schedule.id },
  });

  if (scheduleType === "accrued_expense" && schedule.auto_reverse) {
    // Mark for reversal on next period — actual reversal is explicit
    await supabase
      .from("teller_schedule_occurrences")
      .update({ metadata: { auto_reverse_pending: true } })
      .eq("id", occurrence.id);
  }

  return { journalEntryId: entryId };
}

export async function processDueScheduleOccurrences(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    asOfDate: string;
    actorId?: string | null;
    autoPost?: boolean;
  },
): Promise<ProcessDueResult> {
  const asOf = input.asOfDate.slice(0, 10);
  const { data: schedules } = await supabase
    .from("teller_accounting_schedules")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("status", "active")
    .lte("next_occurrence_date", asOf);

  const result: ProcessDueResult = { processed: 0, skipped: 0, failed: 0, results: [] };

  for (const schedule of schedules ?? []) {
    const occurrenceDate = (schedule.next_occurrence_date as string)?.slice(0, 10);
    if (!occurrenceDate || occurrenceDate > asOf) {
      result.skipped += 1;
      continue;
    }

    const periodEnd = endOfMonth(
      new Date(occurrenceDate + "T12:00:00").getFullYear(),
      new Date(occurrenceDate + "T12:00:00").getMonth() + 1,
    );

    try {
      const amount =
        schedule.schedule_type === "accrued_expense"
          ? roundMoney(Number(schedule.original_amount))
          : roundMoney(
              Math.min(
                Number(schedule.remaining_amount),
                Number(schedule.original_amount) /
                  Math.max(1, buildPeriodCount(schedule.start_date as string, schedule.end_date as string)),
              ),
            );

      const { occurrence, duplicate } = await claimScheduleOccurrence(supabase, {
        organizationId: input.organizationId,
        scheduleId: schedule.id as string,
        occurrenceDate,
        periodEnd,
        amount,
      });

      if (!occurrence) {
        result.failed += 1;
        continue;
      }

      if (duplicate && occurrence.status === "posted") {
        result.skipped += 1;
        result.results.push({ occurrenceId: occurrence.id as string, status: "posted", detail: "duplicate" });
        continue;
      }

      if (!input.autoPost) {
        await supabase
          .from("teller_schedule_occurrences")
          .update({ status: "generated" })
          .eq("id", occurrence.id);
        result.processed += 1;
        result.results.push({ occurrenceId: occurrence.id as string, status: "generated" });
        continue;
      }

      await postScheduleOccurrence(supabase, {
        organizationId: input.organizationId,
        occurrenceId: occurrence.id as string,
        actorId: input.actorId,
      });
      result.processed += 1;
      result.results.push({ occurrenceId: occurrence.id as string, status: "posted" });
    } catch (error) {
      result.failed += 1;
      result.results.push({
        occurrenceId: schedule.id as string,
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

function buildPeriodCount(startDate: string, endDate: string | null): number {
  if (!endDate) return 12;
  const start = new Date(startDate.slice(0, 10) + "T12:00:00");
  const end = new Date(endDate.slice(0, 10) + "T12:00:00");
  return Math.max(1, (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1);
}

export async function markOccurrenceRequiresReview(
  supabase: SupabaseClient,
  input: { organizationId: string; occurrenceId: string; reason: string },
) {
  await supabase
    .from("teller_schedule_occurrences")
    .update({ status: "failed", failure_reason: input.reason })
    .eq("organization_id", input.organizationId)
    .eq("id", input.occurrenceId);
}

export async function reversePostedOccurrence(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    occurrenceId: string;
    reversalDate: string;
    actorId?: string | null;
  },
) {
  const { data: occurrence } = await supabase
    .from("teller_schedule_occurrences")
    .select("*, teller_accounting_schedules(*)")
    .eq("organization_id", input.organizationId)
    .eq("id", input.occurrenceId)
    .single();
  if (!occurrence?.journal_entry_id) throw new Error("Occurrence not posted");

  const schedule = occurrence.teller_accounting_schedules as Record<string, unknown>;
  const amount = roundMoney(Number(occurrence.amount));
  let lines: Array<Record<string, unknown>>;

  if (schedule.schedule_type === "accrued_expense") {
    lines = accrualReversalLines({
      amount,
      expenseAccountId: schedule.expense_account_id as string,
      liabilityAccountId: schedule.liability_account_id as string,
      jobId: (schedule.job_id as string) ?? null,
    });
  } else if (schedule.schedule_type === "prepaid_expense") {
    lines = prepaidJournalLines({
      amount,
      expenseAccountId: schedule.prepaid_account_id as string,
      prepaidAccountId: schedule.expense_account_id as string,
      jobId: (schedule.job_id as string) ?? null,
    });
  } else {
    lines = deferredRevenueJournalLines({
      amount,
      liabilityAccountId: schedule.revenue_account_id as string,
      revenueAccountId: schedule.liability_account_id as string,
      jobId: (schedule.job_id as string) ?? null,
    });
  }

  const reversalId = await postJournal(supabase, {
    organizationId: input.organizationId,
    entryDate: input.reversalDate.slice(0, 10),
    memo: `Reversal: ${schedule.name}`,
    sourceKind: "schedule-reversal",
    sourceId: occurrence.id as string,
    reversesEntryId: occurrence.journal_entry_id as string,
    lines: lines as Parameters<typeof postJournal>[1]["lines"],
  });

  await supabase
    .from("teller_schedule_occurrences")
    .update({
      status: "reversed",
      reversing_journal_entry_id: reversalId,
    })
    .eq("id", occurrence.id);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "schedule.occurrence_reversed",
    resourceKind: "schedule_occurrence",
    resourceId: occurrence.id as string,
    metadata: { reversalJournalEntryId: reversalId },
  });

  return { reversalJournalEntryId: reversalId };
}
