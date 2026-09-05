import { Suspense } from "react";
import { ReportsView } from "@/components/ReportsView";
import {
  buildArAging,
  buildApAging,
  buildBalanceSheet,
  buildCashFlowStatement,
  parseReportTab,
} from "@/lib/accounting/financial-reports";
import {
  buildProfitAndLossForBasis,
  buildSalesSummary,
  parseAccountingBasis,
  parseReportPeriod,
  reportPeriodRange,
} from "@/lib/accounting/reports";
import { parseFiscalYearStart } from "@/lib/org/config";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { routes } from "@/lib/routes";
import { redirect } from "next/navigation";

type PageProps = {
  searchParams: Promise<{ period?: string; tab?: string }>;
};

export default async function ReportsPage({ searchParams }: PageProps) {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  const params = await searchParams;
  const period = parseReportPeriod(params.period);
  const tab = parseReportTab(params.tab);
  const fiscalYearStart = parseFiscalYearStart(session.settings?.answers?.fiscalYearStart);
  const range = reportPeriodRange(period, new Date(), fiscalYearStart);
  const asOf = range.end ?? new Date().toISOString().slice(0, 10);
  const supabase = await createClient();
  const organizationId = session.organization.id;

  let entriesQuery = supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", organizationId);

  if (range.start) entriesQuery = entriesQuery.gte("entry_date", range.start);
  if (range.end) entriesQuery = entriesQuery.lte("entry_date", range.end);

  const [
    { data: entries },
    { data: cumulativeEntries },
    { data: accounts },
    { data: invoices },
    { data: expenses },
    { data: parties },
  ] = await Promise.all([
    entriesQuery,
    supabase
      .from("teller_journal_entries")
      .select("id, entry_date")
      .eq("organization_id", organizationId)
      .lte("entry_date", asOf),
    supabase
      .from("teller_accounts")
      .select("id, code, name, type, subtype")
      .eq("organization_id", organizationId)
      .order("code"),
    supabase
      .from("teller_documents")
      .select("status, total, amount_paid, issue_date, due_date, party_id, posted_entry_id")
      .eq("organization_id", organizationId)
      .eq("kind", "invoice"),
    supabase
      .from("teller_documents")
      .select("status, total, amount_paid, issue_date, due_date, party_id, posted_entry_id")
      .eq("organization_id", organizationId)
      .eq("kind", "expense"),
    supabase.from("teller_parties").select("id, name").eq("organization_id", organizationId),
  ]);

  const entryIds = (entries ?? []).map((row) => row.id);
  const cumulativeEntryIds = (cumulativeEntries ?? []).map((row) => row.id);
  const entryDates = new Map((cumulativeEntries ?? []).map((row) => [row.id, row.entry_date]));

  const [{ data: journalLines }, { data: cumulativeLines }] = await Promise.all([
    entryIds.length
      ? supabase
          .from("teller_journal_lines")
          .select("account_id, debit, credit")
          .in("entry_id", entryIds)
      : Promise.resolve({ data: [] }),
    cumulativeEntryIds.length
      ? supabase
          .from("teller_journal_lines")
          .select("entry_id, account_id, debit, credit")
          .in("entry_id", cumulativeEntryIds)
      : Promise.resolve({ data: [] }),
  ]);

  const datedJournalLines = (cumulativeLines ?? []).flatMap((line) => {
    const entryDate = entryDates.get(line.entry_id);
    if (!entryDate) return [];
    return [
      {
        account_id: line.account_id,
        debit: line.debit,
        credit: line.credit,
        entry_date: entryDate,
      },
    ];
  });

  const basis = parseAccountingBasis(session.settings?.answers?.basis);
  const partyNames = new Map((parties ?? []).map((row) => [row.id, row.name]));
  const profitAndLoss = buildProfitAndLossForBasis(
    basis,
    invoices ?? [],
    journalLines ?? [],
    accounts ?? [],
    range,
  );
  const sales = buildSalesSummary(invoices ?? [], partyNames, range, basis);
  const balanceSheet = buildBalanceSheet(datedJournalLines, accounts ?? [], asOf);
  const cashFlow = buildCashFlowStatement(
    datedJournalLines,
    accounts ?? [],
    range,
    profitAndLoss,
  );
  const arAging = buildArAging(invoices ?? [], partyNames, asOf);
  const apAging = buildApAging(expenses ?? [], partyNames, asOf);

  return (
    <div className="space-y-6">
      <header className="page-header">
        <h1>Reports</h1>
        <p>
          Financial statements and sales analysis ·{" "}
          {basis === "cash" ? "Cash basis" : "Accrual basis"}
        </p>
      </header>
      <Suspense fallback={<p className="text-sm text-muted">Loading reports…</p>}>
        <ReportsView
          period={period}
          periodLabel={range.label}
          asOf={asOf}
          tab={tab}
          basis={basis}
          sales={sales}
          profitAndLoss={profitAndLoss}
          balanceSheet={balanceSheet}
          cashFlow={cashFlow}
          arAging={arAging}
          apAging={apAging}
        />
      </Suspense>
    </div>
  );
}
