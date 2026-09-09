import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { roundMoney } from "@/lib/accounting/payment-fees";
import type { NormalizedCashEvent } from "./cash-event";
import { projectCashEvents } from "./cash-event";
import {
  generateRecurrenceOccurrences,
  paymentDateFromOccurrence,
  type BillRecurrence,
} from "./recurrence-dates";
import type { CashFlowLine, CashHorizonWeek } from "./types";

export const NONCASH_RECURRING_SCHEDULE_TYPES = new Set([
  "prepaid_expense",
  "deferred_revenue",
  "depreciation",
]);

export function isNonCashRecurringSchedule(scheduleType: string): boolean {
  return NONCASH_RECURRING_SCHEDULE_TYPES.has(scheduleType);
}

export async function loadRecurringCashEvents(
  supabase: SupabaseClient,
  organizationId: string,
  input: {
    asOfDate: string;
    horizonStart: string;
    horizonEnd: string;
    defaultApDays: number;
  },
): Promise<{
  events: NormalizedCashEvent[];
  recurringBillKeysWithPostedBills: Set<string>;
}> {
  const events: NormalizedCashEvent[] = [];
  const recurringBillKeysWithPostedBills = new Set<string>();

  const { data: templates, error: templateError } = await supabase
    .from("teller_recurring_bill_templates")
    .select("id, name, recurrence, start_date, end_date, issue_day_of_month, default_due_days, active, template_status, tax")
    .eq("organization_id", organizationId)
    .eq("active", true)
    .eq("template_status", "active");
  if (templateError) throw new Error(templateError.message);

  const templateIds = (templates ?? []).map((row) => row.id as string);
  const lineTotals = new Map<string, number>();
  if (templateIds.length) {
    const { data: lines, error: linesError } = await supabase
      .from("teller_recurring_bill_template_lines")
      .select("template_id, amount")
      .in("template_id", templateIds);
    if (linesError) throw new Error(linesError.message);
    for (const line of lines ?? []) {
      const templateId = line.template_id as string;
      lineTotals.set(templateId, roundMoney((lineTotals.get(templateId) ?? 0) + asNumber(line.amount)));
    }
  }

  const { data: runs, error: runsError } = await supabase
    .from("teller_recurring_bill_runs")
    .select("template_id, occurrence_date, document_id")
    .eq("organization_id", organizationId);
  if (runsError) throw new Error(runsError.message);

  const postedRunKeys = new Set<string>();
  for (const run of runs ?? []) {
    if (!run.document_id) continue;
    const key = `${run.template_id}:${(run.occurrence_date as string).slice(0, 10)}`;
    postedRunKeys.add(key);
    recurringBillKeysWithPostedBills.add(`recurring:${key}`);
  }

  const { data: recurringBills, error: billsError } = await supabase
    .from("teller_documents")
    .select("id, metadata, status")
    .eq("organization_id", organizationId)
    .eq("kind", "bill")
    .in("status", ["open", "partially_paid", "draft"]);
  if (billsError) throw new Error(billsError.message);

  for (const bill of recurringBills ?? []) {
    const meta = bill.metadata as Record<string, unknown> | null;
    const templateId = meta?.recurring_template_id as string | undefined;
    const occurrence = meta?.recurring_occurrence as string | undefined;
    if (templateId && occurrence) {
      recurringBillKeysWithPostedBills.add(`recurring:${templateId}:${occurrence.slice(0, 10)}`);
    }
  }

  for (const template of templates ?? []) {
    const templateId = template.id as string;
    const subtotal = lineTotals.get(templateId) ?? 0;
    const total = roundMoney(subtotal + asNumber(template.tax));
    if (total <= 0.009) continue;

    const dueDays = template.default_due_days ?? input.defaultApDays;
    const occurrences = generateRecurrenceOccurrences({
      recurrence: template.recurrence as BillRecurrence,
      startDate: template.start_date as string,
      endDate: (template.end_date as string | null) ?? null,
      fromDate: input.asOfDate,
      throughDate: input.horizonEnd,
      issueDayOfMonth: template.issue_day_of_month as number | null,
    });

    for (const occurrenceDate of occurrences) {
      const dedupeKey = `recurring:${templateId}:${occurrenceDate}`;
      if (postedRunKeys.has(`${templateId}:${occurrenceDate}`)) continue;
      if (recurringBillKeysWithPostedBills.has(dedupeKey)) continue;

      const paymentDate = paymentDateFromOccurrence(occurrenceDate, dueDays);
      events.push({
        organizationId,
        sourceType: "recurring_bill",
        sourceId: templateId,
        sourceLabel: template.name as string,
        expectedDate: paymentDate,
        amount: total,
        flowKind: "outflow",
        category: "recurring",
        dedupeKey,
        sourceQuality: "scheduled",
        explanation: `Recurring — ${template.name as string} — ${occurrenceDate}`,
        drilldownPath: `/app/purchasing/recurring-bills/${templateId}`,
        metadata: { templateId, occurrenceDate, paymentDate },
      });
    }
  }

  return {
    events: events.filter((event) => event.amount > 0.009),
    recurringBillKeysWithPostedBills,
  };
}

export async function projectRecurringCash(
  supabase: SupabaseClient,
  organizationId: string,
  input: {
    asOfDate: string;
    horizonWeeks: CashHorizonWeek[];
    horizonStart: string;
    horizonEnd: string;
    defaultApDays: number;
  },
): Promise<{
  lines: CashFlowLine[];
  recurringBillKeysWithPostedBills: Set<string>;
}> {
  const loaded = await loadRecurringCashEvents(supabase, organizationId, input);
  return {
    lines: projectCashEvents(loaded.events, input),
    recurringBillKeysWithPostedBills: loaded.recurringBillKeysWithPostedBills,
  };
}
