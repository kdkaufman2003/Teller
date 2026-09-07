import type { SupabaseClient } from "@supabase/supabase-js";
import { roundMoney } from "../payment-fees";
import { assertNoDoubleCountWithAppliedDeposit } from "./deferred-revenue";
import { buildSchedulePreview } from "./preview";
import type { RecognitionMethod, ScheduleStatus, ScheduleType } from "./types";
import { buildPrepaidRecognitionPeriods } from "./prepaid";
import { recordAuditEvent } from "../audit";
import {
  actionToStatus,
  assertLifecycleTransition,
  canEditScheduleFields,
  canEditLimitedActiveFields,
} from "./lifecycle";

export type CreateScheduleInput = {
  organizationId: string;
  scheduleType: ScheduleType;
  name: string;
  reference?: string;
  memo?: string;
  vendorPartyId?: string | null;
  sourceDocumentId?: string | null;
  sourcePaymentId?: string | null;
  startDate: string;
  endDate?: string | null;
  originalAmount: number;
  expenseAccountId?: string | null;
  prepaidAccountId?: string | null;
  liabilityAccountId?: string | null;
  revenueAccountId?: string | null;
  frequency?: "monthly" | "quarterly" | "annually";
  recognitionMethod?: RecognitionMethod;
  autoReverse?: boolean;
  reversalTiming?: string | null;
  jobId?: string | null;
  depositAvailable?: number | null;
  depositApplied?: number | null;
  actorId?: string | null;
};

function firstOccurrenceDate(startDate: string, endDate: string | null): string {
  const preview = buildPrepaidRecognitionPeriods({
    startDate,
    endDate: endDate ?? startDate,
    originalAmount: 1,
  });
  return preview[0]?.occurrenceDate ?? startDate.slice(0, 10);
}

export function validateCreateScheduleInput(input: CreateScheduleInput): void {
  if (!input.name.trim()) throw new Error("Name is required");
  if (input.originalAmount <= 0) throw new Error("Amount must be positive");

  if (input.scheduleType === "prepaid_expense") {
    if (!input.prepaidAccountId || !input.expenseAccountId) {
      throw new Error("Prepaid and expense accounts are required");
    }
    if (!input.endDate) throw new Error("End date is required for prepaid schedules");
  }

  if (input.scheduleType === "accrued_expense") {
    if (!input.expenseAccountId || !input.liabilityAccountId) {
      throw new Error("Expense and accrued liability accounts are required");
    }
  }

  if (input.scheduleType === "deferred_revenue") {
    if (!input.liabilityAccountId || !input.revenueAccountId) {
      throw new Error("Deposit liability and revenue accounts are required");
    }
    if (!input.sourcePaymentId) throw new Error("Customer deposit source is required");
    if (input.depositAvailable != null && input.originalAmount > input.depositAvailable + 0.009) {
      throw new Error("Recognition schedule exceeds available deposit liability");
    }
    assertNoDoubleCountWithAppliedDeposit({
      depositFullyApplied: (input.depositAvailable ?? 0) <= 0,
      scheduleLinkedToDeposit: Boolean(input.sourcePaymentId),
    });
    if (!input.endDate) throw new Error("End date is required for deferred revenue schedules");
  }
}

export async function createAccountingSchedule(
  supabase: SupabaseClient,
  input: CreateScheduleInput,
) {
  validateCreateScheduleInput(input);
  const metadata: Record<string, unknown> = {};
  if (input.reversalTiming) metadata.reversal_timing = input.reversalTiming;
  if (input.depositAvailable != null) metadata.deposit_available = input.depositAvailable;
  if (input.depositApplied != null) metadata.deposit_applied = input.depositApplied;

  const endDate = input.endDate?.slice(0, 10) ?? null;
  const nextOccurrence =
    input.scheduleType === "accrued_expense"
      ? input.startDate.slice(0, 10)
      : endDate
        ? firstOccurrenceDate(input.startDate, endDate)
        : null;

  const { data, error } = await supabase
    .from("teller_accounting_schedules")
    .insert({
      organization_id: input.organizationId,
      schedule_type: input.scheduleType,
      status: "draft",
      name: input.name.trim(),
      reference: input.reference?.trim() ?? "",
      memo: input.memo?.trim() ?? "",
      vendor_party_id: input.vendorPartyId ?? null,
      source_document_id: input.sourceDocumentId ?? null,
      source_payment_id: input.sourcePaymentId ?? null,
      start_date: input.startDate.slice(0, 10),
      end_date: endDate,
      original_amount: roundMoney(input.originalAmount),
      remaining_amount: roundMoney(input.originalAmount),
      expense_account_id: input.expenseAccountId ?? null,
      prepaid_account_id: input.prepaidAccountId ?? null,
      liability_account_id: input.liabilityAccountId ?? null,
      revenue_account_id: input.revenueAccountId ?? null,
      frequency: input.frequency ?? "monthly",
      recognition_method: input.recognitionMethod ?? "straight_line_monthly",
      next_occurrence_date: nextOccurrence,
      auto_reverse: input.autoReverse ?? false,
      job_id: input.jobId ?? null,
      metadata,
      created_by: input.actorId ?? null,
    })
    .select("*")
    .single();

  if (error || !data) throw new Error(error?.message || "Could not create schedule");

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "schedule.created",
    resourceKind: "accounting_schedule",
    resourceId: data.id as string,
  });

  return data;
}

export async function updateAccountingSchedule(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    scheduleId: string;
    patch: Partial<CreateScheduleInput>;
    actorId?: string | null;
  },
) {
  const { data: existing, error } = await supabase
    .from("teller_accounting_schedules")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("id", input.scheduleId)
    .single();
  if (error || !existing) throw new Error(error?.message || "Schedule not found");

  const status = existing.status as ScheduleStatus;
  if (!canEditScheduleFields(status) && !canEditLimitedActiveFields(status)) {
    throw new Error("Only draft or paused schedules can be edited");
  }
  if (status !== "draft" && (input.patch.originalAmount != null || input.patch.startDate != null)) {
    throw new Error("Amount and start date can only be changed on draft schedules");
  }

  const merged: CreateScheduleInput = {
    organizationId: input.organizationId,
    scheduleType: (input.patch.scheduleType ?? existing.schedule_type) as ScheduleType,
    name: input.patch.name ?? (existing.name as string),
    reference: input.patch.reference ?? (existing.reference as string),
    memo: input.patch.memo ?? (existing.memo as string),
    startDate: input.patch.startDate ?? (existing.start_date as string),
    endDate: input.patch.endDate ?? (existing.end_date as string | null),
    originalAmount: input.patch.originalAmount ?? Number(existing.original_amount),
    expenseAccountId: input.patch.expenseAccountId ?? (existing.expense_account_id as string),
    prepaidAccountId: input.patch.prepaidAccountId ?? (existing.prepaid_account_id as string),
    liabilityAccountId: input.patch.liabilityAccountId ?? (existing.liability_account_id as string),
    revenueAccountId: input.patch.revenueAccountId ?? (existing.revenue_account_id as string),
    sourcePaymentId: input.patch.sourcePaymentId ?? (existing.source_payment_id as string),
    recognitionMethod: input.patch.recognitionMethod ?? (existing.recognition_method as RecognitionMethod),
    autoReverse: input.patch.autoReverse ?? Boolean(existing.auto_reverse),
    jobId: input.patch.jobId ?? (existing.job_id as string),
    depositAvailable: input.patch.depositAvailable ?? null,
  };
  validateCreateScheduleInput(merged);

  const { data, error: updateError } = await supabase
    .from("teller_accounting_schedules")
    .update({
      name: merged.name.trim(),
      reference: merged.reference?.trim() ?? "",
      memo: merged.memo?.trim() ?? "",
      end_date: merged.endDate?.slice(0, 10) ?? null,
      original_amount: roundMoney(merged.originalAmount),
      remaining_amount: status === "draft" ? roundMoney(merged.originalAmount) : existing.remaining_amount,
      expense_account_id: merged.expenseAccountId ?? null,
      prepaid_account_id: merged.prepaidAccountId ?? null,
      liability_account_id: merged.liabilityAccountId ?? null,
      revenue_account_id: merged.revenueAccountId ?? null,
      recognition_method: merged.recognitionMethod ?? "straight_line_monthly",
      auto_reverse: merged.autoReverse ?? false,
      job_id: merged.jobId ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.scheduleId)
    .select("*")
    .single();

  if (updateError || !data) throw new Error(updateError?.message || "Could not update schedule");

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "schedule.updated",
    resourceKind: "accounting_schedule",
    resourceId: input.scheduleId,
  });

  return data;
}

export async function activateAccountingSchedule(
  supabase: SupabaseClient,
  input: { organizationId: string; scheduleId: string; actorId?: string | null },
) {
  const { data: schedule } = await supabase
    .from("teller_accounting_schedules")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("id", input.scheduleId)
    .single();
  if (!schedule) throw new Error("Schedule not found");

  assertLifecycleTransition(schedule.status as ScheduleStatus, "active");
  validateCreateScheduleInput({
    organizationId: input.organizationId,
    scheduleType: schedule.schedule_type as ScheduleType,
    name: schedule.name as string,
    startDate: schedule.start_date as string,
    endDate: schedule.end_date as string | null,
    originalAmount: Number(schedule.original_amount),
    expenseAccountId: schedule.expense_account_id as string,
    prepaidAccountId: schedule.prepaid_account_id as string,
    liabilityAccountId: schedule.liability_account_id as string,
    revenueAccountId: schedule.revenue_account_id as string,
    sourcePaymentId: schedule.source_payment_id as string,
    depositAvailable: (schedule.metadata as { deposit_available?: number })?.deposit_available ?? null,
  });

  const preview = buildSchedulePreview({
    scheduleType: schedule.schedule_type as ScheduleType,
    startDate: schedule.start_date as string,
    endDate: schedule.end_date as string | null,
    originalAmount: Number(schedule.original_amount),
    recognitionMethod: schedule.recognition_method as RecognitionMethod,
  });

  const { data, error } = await supabase
    .from("teller_accounting_schedules")
    .update({
      status: "active",
      next_occurrence_date: preview[0]?.occurrenceDate ?? schedule.start_date,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.scheduleId)
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "Could not activate schedule");

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "schedule.updated",
    resourceKind: "accounting_schedule",
    resourceId: input.scheduleId,
    metadata: { activated: true },
  });

  return { schedule: data, preview };
}

export async function transitionScheduleLifecycle(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    scheduleId: string;
    action: "pause" | "resume" | "cancel";
    actorId?: string | null;
  },
) {
  const { data: schedule } = await supabase
    .from("teller_accounting_schedules")
    .select("status")
    .eq("organization_id", input.organizationId)
    .eq("id", input.scheduleId)
    .single();
  if (!schedule) throw new Error("Schedule not found");

  const next = actionToStatus(input.action);
  if (!next) throw new Error("Invalid action");
  assertLifecycleTransition(schedule.status as ScheduleStatus, next);

  if (input.action === "cancel") {
    const { cancelSchedule } = await import("./schedule-service");
    await cancelSchedule(supabase, input);
    return { status: "cancelled" };
  }
  if (input.action === "pause") {
    const { pauseSchedule } = await import("./schedule-service");
    await pauseSchedule(supabase, input);
    return { status: "paused" };
  }
  const { resumeSchedule } = await import("./schedule-service");
  await resumeSchedule(supabase, input);
  return { status: "active" };
}

export async function loadEligibleDepositSources(
  supabase: SupabaseClient,
  organizationId: string,
) {
  const { data: payments, error } = await supabase
    .from("teller_payments")
    .select("id, amount, payment_date, memo, party_id, status")
    .eq("organization_id", organizationId)
    .eq("payment_type", "customer_payment")
    .order("payment_date", { ascending: false });
  if (error) throw new Error(error.message);

  const sources = [];
  for (const payment of payments ?? []) {
    const { data: allocations } = await supabase
      .from("teller_payment_allocations")
      .select("amount")
      .eq("payment_id", payment.id as string);
    const applied = (allocations ?? []).reduce((s, row) => s + Number(row.amount ?? 0), 0);
    const original = Number(payment.amount ?? 0);
    const available = roundMoney(original - applied);

    const { data: existingSchedules } = await supabase
      .from("teller_accounting_schedules")
      .select("remaining_amount, status")
      .eq("organization_id", organizationId)
      .eq("source_payment_id", payment.id as string)
      .neq("status", "cancelled");

    const scheduledRemaining = (existingSchedules ?? []).reduce(
      (s, row) => s + Number(row.remaining_amount ?? 0),
      0,
    );
    const netAvailable = roundMoney(available - scheduledRemaining);

    sources.push({
      paymentId: payment.id as string,
      paymentDate: payment.payment_date as string,
      memo: payment.memo as string,
      originalAmount: original,
      appliedAmount: roundMoney(applied),
      availableForSchedule: Math.max(0, netAvailable),
      fullyApplied: netAvailable <= 0.009,
    });
  }
  return sources;
}
