import type { SupabaseClient } from "@supabase/supabase-js";
import type { AccountRow } from "@/lib/accounting/reports";
import {
  DEFAULT_PLANNING_SETTINGS,
  parsePlanningSettings,
} from "@/lib/planning/settings/planning-settings";
import { loadOpenReceivables, projectArCollections } from "./ar-adapter";
import { loadOpenPayables, projectApPayments } from "./ap-adapter";
import { projectCapexCash, parseOverridePlanningCategory } from "./capex-adapter";
import {
  aggregateWeeklyCash,
  buildCashWarnings,
  manualOverridesToFlowLines,
} from "./engine";
import { loadStartingCashFromGl } from "./starting-cash";
import { parsePartyOverrides } from "./timing";
import type { CashFlowLine, CashOutlookReport } from "./types";
import { CASH_HORIZON_WEEKS } from "./types";
import { buildCashHorizonWeeks } from "./weeks";
import { listCashManualOverrides } from "./cash-crud";
import { projectPayrollCash } from "./payroll-adapter";
import { projectRecurringCash } from "./recurring-adapter";
import { projectPurchasingCash } from "./purchasing-adapter";
import {
  dedupeCashFlowLines,
  filterProjectedPayrollWhenPosted,
  filterRecurringWhenBillExists,
} from "./dedupe";
import { buildSourceCoverage } from "./source-coverage";

export async function loadCashOutlookReport(
  supabase: SupabaseClient,
  organizationId: string,
  input: {
    asOfDate?: string;
    accounts: AccountRow[];
    persistRun?: boolean;
    actorId?: string | null;
  },
): Promise<CashOutlookReport> {
  const asOfDate = (input.asOfDate ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
  const { weeks: horizonWeeks, horizonStart, horizonEnd } = buildCashHorizonWeeks(
    asOfDate,
    CASH_HORIZON_WEEKS,
  );

  const { data: settingsRow } = await supabase
    .from("teller_planning_settings")
    .select("*")
    .eq("organization_id", organizationId)
    .maybeSingle();
  const settings = parsePlanningSettings(settingsRow);
  const partyOverrides = parsePartyOverrides(
    (settingsRow as Record<string, unknown> | null)?.party_overrides,
  );

  const horizonInput = { horizonWeeks, horizonStart, horizonEnd };

  const [startingCash, receivables, payables, manualOverrides] = await Promise.all([
    loadStartingCashFromGl(supabase, organizationId, asOfDate, input.accounts),
    loadOpenReceivables(supabase, organizationId),
    loadOpenPayables(supabase, organizationId),
    listCashManualOverrides(supabase, organizationId),
  ]);

  const arProjection = projectArCollections({
    receivables,
    horizonWeeks,
    horizonStart,
    horizonEnd,
    defaultArDays: settings.defaultArCollectionDays,
    partyOverrides,
  });

  const apProjection = projectApPayments({
    payables,
    horizonWeeks,
    horizonStart,
    horizonEnd,
    defaultApDays: settings.defaultApPaymentDays,
    partyOverrides,
  });

  const generalManualOverrides = manualOverrides.filter(
    (row) => parseOverridePlanningCategory(row.notes) !== "capex",
  );

  const manualLines = manualOverridesToFlowLines({
    overrides: generalManualOverrides,
    ...horizonInput,
  });

  const [payrollProjection, recurringProjection, purchasingProjection] = await Promise.all([
    projectPayrollCash(supabase, organizationId, {
      asOfDate,
      ...horizonInput,
      payrollCadence: settings.payrollCadence,
    }),
    projectRecurringCash(supabase, organizationId, {
      asOfDate,
      ...horizonInput,
      defaultApDays: settings.defaultApPaymentDays,
    }),
    projectPurchasingCash(supabase, organizationId, {
      asOfDate,
      ...horizonInput,
      defaultApDays: settings.defaultApPaymentDays,
      partyOverrides,
      openPayables: payables,
    }),
  ]);

  const capexProjection = projectCapexCash({
    organizationId,
    ...horizonInput,
    overrides: manualOverrides,
  });

  let mergedLines: CashFlowLine[] = [
    ...arProjection.lines,
    ...apProjection.lines,
    ...payrollProjection.lines,
    ...recurringProjection.lines,
    ...purchasingProjection.lines,
    ...capexProjection.lines,
    ...manualLines,
  ];

  mergedLines = filterRecurringWhenBillExists(
    mergedLines,
    recurringProjection.recurringBillKeysWithPostedBills,
  );
  mergedLines = filterProjectedPayrollWhenPosted(
    mergedLines,
    payrollProjection.postedPayDates,
  );

  const { lines: flowLines, diagnostics } = dedupeCashFlowLines(mergedLines);

  const unscheduledPurchasing = flowLines.filter(
    (line) => line.category === "purchasing" && line.metadata?.unscheduled === true,
  );
  const scheduledLines = flowLines.filter(
    (line) => !(line.category === "purchasing" && line.metadata?.unscheduled === true),
  );

  const { weeks, beyondHorizon, summary } = aggregateWeeklyCash({
    startingCash: startingCash.total,
    horizonWeeks,
    flowLines: scheduledLines,
  });

  const warnings = buildCashWarnings({
    startingCashAccounts: startingCash.accounts.length,
    arOverdueCount: arProjection.overdueCount,
    apOverdueCount: apProjection.overdueCount,
    arDefaultTimingCount: arProjection.defaultTimingCount,
    apDefaultTimingCount: apProjection.defaultTimingCount,
    firstNegativeWeekIndex: summary.firstNegativeWeekIndex,
    payrollMissingAmount: payrollProjection.missingAmountWarning,
    unscheduledPurchasingCount: purchasingProjection.unscheduledCount,
    dedupeDroppedCount: diagnostics.droppedCount,
  });

  const sourceCoverage = buildSourceCoverage(flowLines);

  const report: CashOutlookReport = {
    asOfDate,
    horizonWeeks: CASH_HORIZON_WEEKS,
    horizonStart,
    horizonEnd,
    startingCash,
    weeks,
    beyondHorizon,
    unscheduledPurchasing,
    summary,
    warnings,
    sourceCoverage,
    settings: {
      defaultArCollectionDays: settings.defaultArCollectionDays,
      defaultApPaymentDays: settings.defaultApPaymentDays,
      payrollCadence: settings.payrollCadence,
    },
  };

  if (input.persistRun) {
    const { persistCashForecastRun } = await import("./cash-crud");
    report.runId = await persistCashForecastRun(supabase, {
      organizationId,
      actorId: input.actorId,
      report,
      settingsSnapshot: {
        defaultArCollectionDays: settings.defaultArCollectionDays,
        defaultApPaymentDays: settings.defaultApPaymentDays,
        payrollCadence: settings.payrollCadence,
        partyOverrides: Object.fromEntries(partyOverrides),
      },
    });
  }

  return report;
}

export { DEFAULT_PLANNING_SETTINGS };
