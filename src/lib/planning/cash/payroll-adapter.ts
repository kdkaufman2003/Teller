import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { roundMoney } from "@/lib/accounting/payment-fees";
import type { PlanningSettings } from "@/lib/planning/settings/planning-settings";
import type { NormalizedCashEvent } from "./cash-event";
import { projectPayrollDates } from "./payroll-cadence";
import type { CashHorizonWeek } from "./types";
import { projectCashEvents } from "./cash-event";
import type { CashFlowLine } from "./types";

export type PayrollCashProjection = {
  events: NormalizedCashEvent[];
  lines: CashFlowLine[];
  postedPayDates: Set<string>;
  missingAmountWarning: boolean;
};

export async function loadPayrollCashEvents(
  supabase: SupabaseClient,
  organizationId: string,
  input: {
    asOfDate: string;
    horizonWeeks: CashHorizonWeek[];
    horizonStart: string;
    horizonEnd: string;
    payrollCadence: PlanningSettings["payrollCadence"];
  },
): Promise<{
  events: NormalizedCashEvent[];
  postedPayDates: Set<string>;
  missingAmountWarning: boolean;
}> {
  const events: NormalizedCashEvent[] = [];
  const postedPayDates = new Set<string>();

  const { data: runs, error: runsError } = await supabase
    .from("teller_payroll_runs")
    .select("id, pay_date, status, net_pay, total_liability, gross_wages")
    .eq("organization_id", organizationId)
    .eq("status", "posted")
    .order("pay_date", { ascending: true });
  if (runsError) throw new Error(runsError.message);

  const postedRuns = runs ?? [];
  const runIds = postedRuns.map((row) => row.id as string);

  const settlementTotals = new Map<string, number>();
  if (runIds.length) {
    const { data: settlements, error: settlementError } = await supabase
      .from("teller_payroll_liability_settlements")
      .select("payroll_run_id, amount, journal_entry_id")
      .eq("organization_id", organizationId)
      .in("payroll_run_id", runIds);
    if (settlementError) throw new Error(settlementError.message);

    for (const row of settlements ?? []) {
      if (!row.journal_entry_id) continue;
      const runId = row.payroll_run_id as string;
      settlementTotals.set(runId, roundMoney((settlementTotals.get(runId) ?? 0) + asNumber(row.amount)));
    }
  }

  for (const run of postedRuns) {
    const runId = run.id as string;
    const payDate = (run.pay_date as string).slice(0, 10);
    postedPayDates.add(payDate);
    const totalLiability = asNumber(run.total_liability);
    const settled = settlementTotals.get(runId) ?? 0;
    const remaining = roundMoney(Math.max(0, totalLiability - settled));
    if (remaining <= 0.009) continue;

    events.push({
      organizationId,
      sourceType: "payroll_posted",
      sourceId: runId,
      sourceLabel: `Payroll ${payDate}`,
      expectedDate: payDate,
      amount: remaining,
      flowKind: "outflow",
      category: "payroll",
      dedupeKey: `payroll:run:${runId}`,
      sourceQuality: "confirmed",
      explanation: `Payroll — unpaid settlement — ${payDate}`,
      drilldownPath: `/app/payroll/runs/${runId}`,
      metadata: { payDate, runId, remainingCash: remaining },
    });
  }

  const lastPosted = postedRuns[postedRuns.length - 1];
  const anchorPayDate = (lastPosted?.pay_date as string | undefined)?.slice(0, 10);
  const basisAmount = lastPosted ? asNumber(lastPosted.total_liability) : 0;
  let missingAmountWarning = false;

  if (anchorPayDate && basisAmount > 0.009) {
    const futureDates = projectPayrollDates({
      cadence: input.payrollCadence,
      anchorPayDate,
      fromDate: input.asOfDate,
      throughDate: input.horizonEnd,
    });

    for (const payDate of futureDates) {
      if (postedPayDates.has(payDate)) continue;
      events.push({
        organizationId,
        sourceType: "payroll_projection",
        sourceId: `projected:${payDate}`,
        sourceLabel: `Payroll ${payDate}`,
        expectedDate: payDate,
        amount: basisAmount,
        flowKind: "outflow",
        category: "payroll",
        dedupeKey: `payroll:projected:${payDate}`,
        sourceQuality: "scheduled",
        explanation: `Payroll — scheduled — ${payDate}`,
        metadata: { payDate, basisAmount, cadence: input.payrollCadence },
      });
    }
  } else if (!lastPosted) {
    missingAmountWarning = true;
  }

  return { events, postedPayDates, missingAmountWarning };
}

export async function projectPayrollCash(
  supabase: SupabaseClient,
  organizationId: string,
  input: {
    asOfDate: string;
    horizonWeeks: CashHorizonWeek[];
    horizonStart: string;
    horizonEnd: string;
    payrollCadence: PlanningSettings["payrollCadence"];
  },
): Promise<PayrollCashProjection> {
  const loaded = await loadPayrollCashEvents(supabase, organizationId, input);
  const lines = projectCashEvents(loaded.events, input);
  return {
    events: loaded.events,
    lines,
    postedPayDates: loaded.postedPayDates,
    missingAmountWarning: loaded.missingAmountWarning,
  };
}
