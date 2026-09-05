import { Suspense } from "react";
import { ReportsView } from "@/components/ReportsView";
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
  searchParams: Promise<{ period?: string }>;
};

export default async function ReportsPage({ searchParams }: PageProps) {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  const params = await searchParams;
  const period = parseReportPeriod(params.period);
  const fiscalYearStart = parseFiscalYearStart(session.settings?.answers?.fiscalYearStart);
  const range = reportPeriodRange(period, new Date(), fiscalYearStart);
  const supabase = await createClient();
  const organizationId = session.organization.id;

  let entriesQuery = supabase
    .from("teller_journal_entries")
    .select("id")
    .eq("organization_id", organizationId);

  if (range.start) entriesQuery = entriesQuery.gte("entry_date", range.start);
  if (range.end) entriesQuery = entriesQuery.lte("entry_date", range.end);

  const [{ data: entries }, { data: accounts }, { data: invoices }, { data: parties }] =
    await Promise.all([
      entriesQuery,
      supabase
        .from("teller_accounts")
        .select("id, code, name, type")
        .eq("organization_id", organizationId)
        .order("code"),
      supabase
        .from("teller_documents")
        .select("status, total, amount_paid, issue_date, party_id, posted_entry_id")
        .eq("organization_id", organizationId)
        .eq("kind", "invoice"),
      supabase.from("teller_parties").select("id, name").eq("organization_id", organizationId),
    ]);

  const entryIds = (entries ?? []).map((row) => row.id);
  const { data: journalLines } = entryIds.length
    ? await supabase
        .from("teller_journal_lines")
        .select("account_id, debit, credit")
        .in("entry_id", entryIds)
    : { data: [] };

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

  return (
    <div className="space-y-6">
      <header className="page-header">
        <h1>Reports</h1>
        <p>
          Sales analysis and profit &amp; loss ·{" "}
          {basis === "cash" ? "Cash basis" : "Accrual basis"}
        </p>
      </header>
      <Suspense fallback={<p className="text-sm text-muted">Loading reports…</p>}>
        <ReportsView
          period={period}
          periodLabel={range.label}
          basis={basis}
          sales={sales}
          profitAndLoss={profitAndLoss}
        />
      </Suspense>
    </div>
  );
}
