import type { SupabaseClient } from "@supabase/supabase-js";
import { loadAccountingStateVersions } from "./accounting-state";
import { buildCloseReconciliationSummary } from "./close-reconciliation-summary";
import { buildTrialBalance } from "./trial-balance";
import { listUnassignedJobActivity } from "./unassigned-job-activity";
import { listUnassignedFixedAssetActivity } from "./unassigned-fixed-asset-activity";
import { endOfMonth } from "./periods";
import {
  classifyScheduleCloseFinding,
  filterDueOnOrBefore,
  filterFutureOccurrences,
  type ScheduleCloseItem,
} from "./schedules/close-integration";
import {
  classifyAccrualSettlementCloseFinding,
  type AccrualSettlementCloseItem,
} from "./accrual-settlement/close-integration";
import { computeOccurrenceSettlementStatus } from "./accrual-settlement/status";

export type CloseFinding = {
  key: string;
  domain: string;
  severity: "blocker" | "warning" | "informational";
  title: string;
  description: string;
  difference?: number;
  route?: string;
  details?: unknown;
};

export type CloseReadinessReport = {
  periodEnd: string;
  status: "not_ready" | "ready_with_warnings" | "ready";
  ready: boolean;
  blockerCount: number;
  warningCount: number;
  informationalCount: number;
  findings: CloseFinding[];
  reconciliations: Awaited<ReturnType<typeof buildCloseReconciliationSummary>>;
  checklist: unknown[];
  accountingVersion: number;
  closeStateVersion: number;
  generatedAt: string;
};

export async function evaluateCloseReadiness(
  supabase: SupabaseClient,
  organizationId: string,
  periodEnd: string,
): Promise<CloseReadinessReport> {
  const asOfDate = periodEnd.slice(0, 10);
  const periodDate = new Date(asOfDate + "T12:00:00");
  const findings: CloseFinding[] = [];
  const stateVersions = await loadAccountingStateVersions(supabase, organizationId);

  const reconciliations = await buildCloseReconciliationSummary(supabase, organizationId, {
    asOfDate,
    periodYear: periodDate.getFullYear(),
    periodMonth: periodDate.getMonth() + 1,
  });

  for (const item of reconciliations) {
    if (!item.blocker) continue;
    findings.push({
      key: item.key,
      domain: item.key.split("_")[0] ?? "general",
      severity: "blocker",
      title: `${item.name} out of balance`,
      description: `Reconciliation difference ${item.difference.toFixed(2)}`,
      difference: item.difference,
      route: item.route,
      details: item.details,
    });
  }

  const tb = await buildTrialBalance(supabase, organizationId, {
    periodStart: asOfDate.slice(0, 8) + "01",
    periodEnd: asOfDate,
  });
  if (!tb.balanced) {
    findings.push({
      key: "trial_balance",
      domain: "general_ledger",
      severity: "blocker",
      title: "Trial balance is not balanced",
      description: `Adjusted debits ${tb.totals.adjustedDebit} vs credits ${tb.totals.adjustedCredit}`,
      route: "/app/accounting/trial-balance",
      details: tb.totals,
    });
  }

  const { data: entries } = await supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", organizationId)
    .lte("entry_date", asOfDate);

  for (const entry of entries ?? []) {
    const { data: lines } = await supabase
      .from("teller_journal_lines")
      .select("debit, credit")
      .eq("entry_id", entry.id as string);
    const debits = (lines ?? []).reduce((s, l) => s + Number(l.debit ?? 0), 0);
    const credits = (lines ?? []).reduce((s, l) => s + Number(l.credit ?? 0), 0);
    if (Math.abs(debits - credits) > 0.009) {
      findings.push({
        key: `unbalanced_${entry.id}`,
        domain: "general_ledger",
        severity: "blocker",
        title: "Unbalanced journal entry detected",
        description: `Journal ${entry.id} debits ${debits} credits ${credits}`,
      });
      break;
    }
  }

  const unassignedJobs = await listUnassignedJobActivity(supabase, organizationId);
  if (unassignedJobs.length) {
    findings.push({
      key: "unassigned_job_activity",
      domain: "jobs",
      severity: "warning",
      title: "Unassigned job-costable activity",
      description: `${unassignedJobs.length} document line(s) lack job assignment`,
      route: "/app/jobs/unassigned",
      details: { count: unassignedJobs.length },
    });
  }

  const unassignedFa = await listUnassignedFixedAssetActivity(supabase, organizationId);
  if (unassignedFa.length) {
    findings.push({
      key: "unassigned_fa_activity",
      domain: "fixed_assets",
      severity: "warning",
      title: "Unassigned fixed asset GL activity",
      description: `${unassignedFa.length} journal line(s) on FA control accounts without asset link`,
      route: "/app/assets/reconciliation",
      details: { count: unassignedFa.length },
    });
  }

  const { data: checklist } = await supabase
    .from("teller_close_checklist_items")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("period_end", asOfDate);

  for (const item of checklist ?? []) {
    if (item.required && item.status !== "completed") {
      findings.push({
        key: `checklist_${item.item_key}`,
        domain: "checklist",
        severity: "blocker",
        title: `Required checklist item incomplete: ${item.title}`,
        description: item.description as string,
      });
    }
  }

  const scheduleItems = await loadScheduleCloseItems(supabase, organizationId, asOfDate);
  for (const item of filterDueOnOrBefore(scheduleItems, asOfDate)) {
    if (item.status === "posted" || item.status === "skipped" || item.status === "reversed") continue;
    findings.push(classifyScheduleCloseFinding(item));
  }
  for (const item of filterFutureOccurrences(scheduleItems, asOfDate)) {
    findings.push(classifyScheduleCloseFinding(item, asOfDate));
  }

  const accrualSettlementItems = await loadAccrualSettlementCloseItems(supabase, organizationId, asOfDate);
  for (const item of accrualSettlementItems) {
    findings.push(classifyAccrualSettlementCloseFinding(item));
  }

  const blockerCount = findings.filter((f) => f.severity === "blocker").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;
  const informationalCount = findings.filter((f) => f.severity === "informational").length;

  return {
    periodEnd: asOfDate,
    status:
      blockerCount > 0 ? "not_ready" : warningCount > 0 ? "ready_with_warnings" : "ready",
    ready: blockerCount === 0,
    blockerCount,
    warningCount,
    informationalCount,
    findings,
    reconciliations,
    checklist: checklist ?? [],
    accountingVersion: stateVersions.accountingVersion,
    closeStateVersion: stateVersions.closeStateVersion,
    generatedAt: new Date().toISOString(),
  };
}

export function defaultPeriodEndForMonth(year: number, month: number): string {
  return endOfMonth(year, month);
}

async function loadScheduleCloseItems(
  supabase: SupabaseClient,
  organizationId: string,
  periodEnd: string,
): Promise<ScheduleCloseItem[]> {
  const { data: occurrences, error } = await supabase
    .from("teller_schedule_occurrences")
    .select("id, schedule_id, occurrence_date, amount, status, teller_accounting_schedules(name, schedule_type)")
    .eq("organization_id", organizationId)
    .lte("period_end", periodEnd)
    .in("status", ["scheduled", "generated", "approved", "failed"]);

  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return [];
    throw new Error(error.message);
  }

  return (occurrences ?? []).map((row) => {
    const joined = row as unknown as {
      id: string;
      schedule_id: string;
      occurrence_date: string;
      amount: number;
      status: string;
      teller_accounting_schedules?: { name: string; schedule_type: string } | null;
    };
    const schedule = joined.teller_accounting_schedules;
    return {
      scheduleId: joined.schedule_id,
      occurrenceId: joined.id ?? null,
      scheduleName: schedule?.name ?? "Schedule",
      scheduleType: schedule?.schedule_type ?? "unknown",
      occurrenceDate: joined.occurrence_date,
      amount: Number(joined.amount ?? 0),
      status: joined.status,
      severity: joined.status === "failed" ? "blocker" : "blocker",
    };
  });
}

async function loadAccrualSettlementCloseItems(
  supabase: SupabaseClient,
  organizationId: string,
  periodEnd: string,
): Promise<AccrualSettlementCloseItem[]> {
  const { data: occurrences, error } = await supabase
    .from("teller_schedule_occurrences")
    .select(
      "id, schedule_id, occurrence_date, amount, status, teller_accounting_schedules!inner(name, schedule_type)",
    )
    .eq("organization_id", organizationId)
    .eq("status", "posted")
    .lte("occurrence_date", periodEnd)
    .eq("teller_accounting_schedules.schedule_type", "accrued_expense");

  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return [];
    throw new Error(error.message);
  }

  const occurrenceIds = (occurrences ?? []).map((row) => row.id as string);
  const settledByOccurrence = new Map<string, number>();
  if (occurrenceIds.length > 0) {
    const { data: allocations, error: allocError } = await supabase
      .from("teller_accrual_settlement_allocations")
      .select("occurrence_id, applied_amount, teller_accrual_settlements!inner(status)")
      .eq("organization_id", organizationId)
      .eq("status", "posted")
      .in("occurrence_id", occurrenceIds);

    if (allocError && !/does not exist|schema cache/i.test(allocError.message)) {
      throw new Error(allocError.message);
    }

    for (const row of allocations ?? []) {
      const settlement = row.teller_accrual_settlements as unknown as { status: string };
      if (settlement.status === "reversed") continue;
      const id = row.occurrence_id as string;
      settledByOccurrence.set(
        id,
        (settledByOccurrence.get(id) ?? 0) + Number(row.applied_amount ?? 0),
      );
    }
  }

  const { data: failedSettlements } = await supabase
    .from("teller_accrual_settlements")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("status", "failed")
    .limit(1);

  return (occurrences ?? []).map((row) => {
    const joined = row as unknown as {
      id: string;
      schedule_id: string;
      occurrence_date: string;
      amount: number;
      status: string;
      teller_accounting_schedules?: { name: string; schedule_type: string } | null;
    };
    const accruedAmount = Number(joined.amount ?? 0);
    const settledAmount = settledByOccurrence.get(joined.id) ?? 0;
    const schedule = joined.teller_accounting_schedules;
    return {
      occurrenceId: joined.id,
      scheduleId: joined.schedule_id,
      scheduleName: schedule?.name ?? "Accrual",
      occurrenceDate: joined.occurrence_date,
      accruedAmount,
      settledAmount,
      remainingAmount: accruedAmount - settledAmount,
      settlementStatus: computeOccurrenceSettlementStatus({
        occurrenceAmount: accruedAmount,
        settledAmount,
        occurrenceStatus: joined.status,
      }),
      expectedSettlementDate: periodEnd,
      failedSettlement: (failedSettlements ?? []).length > 0,
    };
  });
}
