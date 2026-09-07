import type { SupabaseClient } from "@supabase/supabase-js";
import { booksClosedThrough } from "./periods";
import { buildProfitAndLossForPeriod } from "./comparative-reports";
import { buildProfitAndLoss } from "./reports";
import {
  type ReportEngineData,
} from "./report-engine";
import { accountBalancesMapFromTotals, loadPeriodTotals, synthesizePeriodPlLines } from "./gl-account-totals";
import { buildReportContext } from "./report-context";
import { computeArControlSubledgerTotal, computeApControlSubledgerTotal } from "./party-balances";
import { computeArOpenSubledgerTotal, computeApOpenSubledgerTotal } from "./subledger";
import { roundMoney } from "./payment-fees";
import { asNumber } from "@/lib/format";
import { accumulateAccountBalances } from "./financial-reports";

export type DashboardFinancialMetrics = {
  cash: { value: number; source: "gl" };
  openAR: { value: number; source: "subledger" };
  openAP: { value: number; source: "subledger" };
  revenue: { value: number; source: "gl" };
  grossProfit: { value: number; source: "gl" };
  netIncome: { value: number; source: "gl" };
  customerDeposits: { value: number; source: "gl" };
  monthEndStatus: { closedThrough: string | null; source: "period_close" };
};

export async function computeDashboardFinancialMetrics(
  supabase: SupabaseClient,
  organizationId: string,
  data: ReportEngineData,
  fiscalYearStart: number,
  basis: "cash" | "accrual" = "accrual",
): Promise<DashboardFinancialMetrics> {
  const today = new Date().toISOString().slice(0, 10);
  const ctx = buildReportContext({
    organizationId,
    period: "month",
    fiscalYearStart,
    basis,
    today: new Date(),
  });

  let pl = buildProfitAndLossForPeriod({
    basis,
    lines: data.datedLines,
    accounts: data.accounts,
    startDate: ctx.startDate,
    endDate: ctx.endDate,
    cashBasis: {
      documents: [...data.invoices, ...data.billsAndExpenses],
      payments: data.payments,
      allocations: data.allocations,
    },
  });

  if (basis === "accrual" && data.usesGlAccountTotalsRpc) {
    const periodTotals = await loadPeriodTotals(
      supabase,
      organizationId,
      ctx.startDate,
      ctx.endDate ?? today,
    );
    if (periodTotals) {
      const periodLines = synthesizePeriodPlLines(
        periodTotals,
        data.accounts,
        (ctx.endDate ?? today).slice(0, 10),
      );
      pl = buildProfitAndLoss(periodLines, data.accounts);
    }
  }

  const balances =
    data.usesGlAccountTotalsRpc && data.cumulativeTotals
      ? accountBalancesMapFromTotals(data.cumulativeTotals, data.accounts)
      : accumulateAccountBalances(data.datedLines, data.accounts, today);
  const cashAccounts = data.accounts.filter(
    (a) => a.subtype === "bank" || a.code === "1000",
  );
  const depositAccounts = data.accounts.filter((a) => a.subtype === "deposit");
  const cash = roundMoney(
    cashAccounts.reduce((s, a) => s + (balances.get(a.id) ?? 0), 0),
  );
  const customerDeposits = roundMoney(
    depositAccounts.reduce((s, a) => s + (balances.get(a.id) ?? 0), 0),
  );

  const [arSub, apSub, closes] = await Promise.all([
    computeArOpenSubledgerTotal(supabase, organizationId),
    computeApOpenSubledgerTotal(supabase, organizationId),
    supabase
      .from("teller_period_closes")
      .select("period_end, effective_closed_through, closed_at, event_type")
      .eq("organization_id", organizationId)
      .order("closed_at", { ascending: false }),
  ]);

  void computeArControlSubledgerTotal;
  void computeApControlSubledgerTotal;

  return {
    cash: { value: cash, source: "gl" },
    openAR: { value: asNumber(arSub.total), source: "subledger" },
    openAP: { value: asNumber(apSub.total), source: "subledger" },
    revenue: { value: pl.totalRevenue, source: "gl" },
    grossProfit: { value: pl.grossProfit, source: "gl" },
    netIncome: { value: pl.netIncome, source: "gl" },
    customerDeposits: { value: customerDeposits, source: "gl" },
    monthEndStatus: {
      closedThrough: booksClosedThrough(closes.data ?? []),
      source: "period_close",
    },
  };
}
