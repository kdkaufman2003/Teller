import Link from "next/link";
import { buildAccountActivityReport } from "@/lib/accounting/account-activity";
import { presentAccountName } from "@/lib/accounting/presentation-mode";
import {
  parseAccountingBasis,
  parseReportPeriod,
  reportPeriodRange,
} from "@/lib/accounting/reports";
import { parseFiscalYearStart } from "@/lib/org/config";
import { money } from "@/lib/format";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { ledgerEntryPath, routes } from "@/lib/routes";
import { redirect, notFound } from "next/navigation";

type PageProps = {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<{
    startDate?: string;
    endDate?: string;
    basis?: string;
    comparison?: string;
    period?: string;
    mode?: string;
  }>;
};

export default async function AccountActivityPage({ params, searchParams }: PageProps) {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  const { accountId } = await params;
  const query = await searchParams;
  const supabase = await createClient();
  const organizationId = session.organization.id;
  const fiscalYearStart = parseFiscalYearStart(session.settings?.answers?.fiscalYearStart);
  const period = parseReportPeriod(query.period);
  const range = reportPeriodRange(period, new Date(), fiscalYearStart);
  const startDate = query.startDate?.slice(0, 10) ?? range.start;
  const endDate = query.endDate?.slice(0, 10) ?? range.end ?? new Date().toISOString().slice(0, 10);
  const basis = parseAccountingBasis(query.basis ?? session.settings?.answers?.basis);
  const presentationMode = query.mode === "owner" ? "owner" : "accountant";

  const { data: account } = await supabase
    .from("teller_accounts")
    .select("id, code, name, type, subtype")
    .eq("organization_id", organizationId)
    .eq("id", accountId)
    .maybeSingle();

  if (!account) notFound();

  const { data: entries } = await supabase
    .from("teller_journal_entries")
    .select("id, entry_date, memo, source_kind, source_id, reverses_entry_id")
    .eq("organization_id", organizationId)
    .lte("entry_date", endDate)
    .order("entry_date");

  const entryIds = (entries ?? []).map((e) => e.id as string);
  const { data: lines } = entryIds.length
    ? await supabase
        .from("teller_journal_lines")
        .select("id, entry_id, account_id, debit, credit, memo")
        .in("entry_id", entryIds)
        .eq("account_id", accountId)
    : { data: [] };

  const report = buildAccountActivityReport({
    account: {
      id: account.id as string,
      code: account.code as string,
      name: account.name as string,
      type: account.type as string,
      subtype: (account.subtype as string | undefined) ?? undefined,
    },
    entries: entries ?? [],
    lines: lines ?? [],
    startDate,
    endDate,
  });

  const backParams = new URLSearchParams();
  backParams.set("period", period);
  backParams.set("tab", "overview");
  if (query.comparison) backParams.set("comparison", query.comparison);
  if (presentationMode === "owner") backParams.set("mode", "owner");

  const accountLabel = presentAccountName(
    presentationMode,
    report.accountName,
    account.subtype as string | null,
  );

  return (
    <div className="space-y-6">
      <header className="page-header">
        <Link href={`${routes.reports}?${backParams.toString()}`} className="text-sm text-muted">
          ← Reports
        </Link>
        <h1 className="mt-2">Account activity</h1>
        <p className="text-muted">
          {report.accountCode} · {accountLabel} · {startDate ?? "Beginning"} through {endDate} ·{" "}
          {basis === "cash" ? "Cash basis" : "Accrual basis"}
          {query.comparison && query.comparison !== "none"
            ? ` · Comparison: ${query.comparison.replace(/_/g, " ")}`
            : ""}
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="card p-4">
          <p className="text-sm text-muted">Opening balance</p>
          <p className="font-ledger mt-1 text-xl">{money(report.openingBalance)}</p>
        </div>
        <div className="card p-4">
          <p className="text-sm text-muted">Closing balance</p>
          <p className="font-ledger mt-1 text-xl">{money(report.closingBalance)}</p>
        </div>
        <div className="card p-4">
          <p className="text-sm text-muted">Lines in period</p>
          <p className="font-ledger mt-1 text-xl">{report.lines.length}</p>
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Memo</th>
              <th className="text-right">Debit</th>
              <th className="text-right">Credit</th>
              <th className="text-right">Balance</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {report.lines.map((line) => (
              <tr key={line.lineId}>
                <td>{line.entryDate}</td>
                <td>
                  <Link href={ledgerEntryPath(line.entryId)} className="text-sky hover:underline">
                    {line.memo || "Journal entry"}
                  </Link>
                </td>
                <td className="text-right font-tabular">{money(line.debit)}</td>
                <td className="text-right font-tabular">{money(line.credit)}</td>
                <td className="text-right font-tabular">{money(line.runningBalance)}</td>
                <td>
                  {line.source.href ? (
                    <Link href={line.source.href} className="text-sm text-sky hover:underline">
                      {line.source.label}
                    </Link>
                  ) : (
                    <span className="text-sm text-muted">{line.source.label}</span>
                  )}
                </td>
              </tr>
            ))}
            {!report.lines.length ? (
              <tr>
                <td colSpan={6} className="py-6 text-center text-muted">
                  No activity in this period for this account.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
