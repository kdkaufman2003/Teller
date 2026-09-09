import { Suspense } from "react";
import { ReportsView } from "@/components/ReportsView";
import { parseReportTab } from "@/lib/accounting/financial-reports";
import {
  buildSalesSummary,
  parseAccountingBasis,
  parseReportPeriod,
  reportPeriodRange,
} from "@/lib/accounting/reports";
import { enrichDocumentsWithAuthoritativePaid } from "@/lib/accounting/balances";
import {
  buildReportContextFromParams,
  buildReportsFromEngine,
  loadReportEngineData,
} from "@/lib/accounting/report-engine";
import type { ReportComparison } from "@/lib/accounting/report-context";
import { parseFiscalYearStart } from "@/lib/org/config";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { loadAccountantPlanningPackage } from "@/lib/planning/accountant-package/load-accountant-planning-package";
import { routes } from "@/lib/routes";
import { redirect } from "next/navigation";

type PageProps = {
  searchParams: Promise<{
    period?: string;
    tab?: string;
    comparison?: string;
    mode?: string;
  }>;
};

function parseComparison(value: string | undefined): ReportComparison {
  if (
    value === "prior_period" ||
    value === "prior_year" ||
    value === "prior_ytd" ||
    value === "none"
  ) {
    return value;
  }
  return "none";
}

export default async function ReportsPage({ searchParams }: PageProps) {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  const params = await searchParams;
  const period = parseReportPeriod(params.period);
  const tab = parseReportTab(params.tab);
  const fiscalYearStart = parseFiscalYearStart(session.settings?.answers?.fiscalYearStart);
  const range = reportPeriodRange(period, new Date(), fiscalYearStart);
  const asOf = range.end ?? new Date().toISOString().slice(0, 10);
  const basis = parseAccountingBasis(session.settings?.answers?.basis);
  const comparison = parseComparison(params.comparison);
  const presentationMode = params.mode === "owner" ? "owner" : "accountant";

  const supabase = await createClient();
  const organizationId = session.organization.id;

  const reportCtx = buildReportContextFromParams({
    organizationId,
    period,
    basis,
    comparison,
    fiscalYearStart,
    presentationMode,
  });

  const engineData = await loadReportEngineData(
    supabase,
    organizationId,
    asOf,
    reportCtx.startDate,
  );
  const reports = await buildReportsFromEngine(supabase, reportCtx, engineData);

  const [invoicesWithPaid] = await Promise.all([
    enrichDocumentsWithAuthoritativePaid(
      supabase,
      organizationId,
      engineData.invoices.map((inv) => ({
        ...inv,
        amount_paid: 0,
        party_id: null,
        due_date: null,
      })),
    ),
  ]);

  const sales = buildSalesSummary(invoicesWithPaid, engineData.partyNames, range, basis);

  const accountByCode = Object.fromEntries(
    engineData.accounts.map((account) => [
      account.code,
      { id: account.id, subtype: account.subtype ?? null },
    ]),
  );

  const planningPackage =
    tab === "planning"
      ? await loadAccountantPlanningPackage(supabase, organizationId, {
          periodEnd: asOf,
          periodLabel: range.label,
          fiscalYear: Number(asOf.slice(0, 4)),
        })
      : null;

  return (
    <div className="space-y-6">
      <header className="page-header">
        <h1>Reports</h1>
        <p>
          Financial statements and sales analysis ·{" "}
          {basis === "cash" ? "Cash basis" : "Accrual basis"}
          {comparison !== "none" ? ` · Compared to ${comparison.replace(/_/g, " ")}` : ""}
          {presentationMode === "owner" ? " · Owner view" : ""}
        </p>
      </header>
      <Suspense fallback={<p className="text-sm text-muted">Loading reports…</p>}>
        <ReportsView
          period={period}
          periodLabel={range.label}
          periodStart={reportCtx.startDate}
          periodEnd={asOf}
          asOf={asOf}
          tab={tab}
          basis={basis}
          comparison={comparison}
          presentationMode={presentationMode}
          accountByCode={accountByCode}
          sales={sales}
          profitAndLoss={reports.profitAndLoss}
          comparativeProfitAndLoss={reports.comparativeProfitAndLoss}
          balanceSheet={reports.balanceSheet}
          comparativeBalanceSheet={reports.comparativeBalanceSheet}
          cashFlow={reports.cashFlow}
          arAging={reports.arAging}
          apAging={reports.apAging}
          planningPackage={planningPackage}
        />
      </Suspense>
    </div>
  );
}
