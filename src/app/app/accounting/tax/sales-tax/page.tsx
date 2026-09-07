import Link from "next/link";
import { buildSalesTaxSummary } from "@/lib/accounting/sales-tax-summary";
import { asNumber } from "@/lib/format";
import { money } from "@/lib/format";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { routes } from "@/lib/routes";
import { redirect } from "next/navigation";
import {
  parseReportPeriod,
  reportPeriodRange,
} from "@/lib/accounting/reports";
import { parseFiscalYearStart } from "@/lib/org/config";

type PageProps = {
  searchParams: Promise<{ period?: string }>;
};

export default async function SalesTaxSummaryPage({ searchParams }: PageProps) {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  const params = await searchParams;
  const fiscalYearStart = parseFiscalYearStart(session.settings?.answers?.fiscalYearStart);
  const period = parseReportPeriod(params.period);
  const range = reportPeriodRange(period, new Date(), fiscalYearStart);
  const periodEnd = range.end ?? new Date().toISOString().slice(0, 10);
  const periodStart = range.start;
  const orgTaxMode = session.settings?.answers?.salesTaxMode as string | undefined;

  const supabase = await createClient();
  const organizationId = session.organization.id;

  const [{ data: documents }, { data: taxAccounts }] = await Promise.all([
    supabase
      .from("teller_documents")
      .select("kind, status, issue_date, subtotal, tax")
      .eq("organization_id", organizationId)
      .in("kind", ["invoice", "credit_memo"])
      .neq("status", "void"),
    supabase
      .from("teller_accounts")
      .select("id, code, name, subtype")
      .eq("organization_id", organizationId)
      .eq("subtype", "sales_tax_payable"),
  ]);

  const taxPayableAccount = (taxAccounts ?? [])[0];
  let salesTaxPayableGlBalance = 0;
  if (taxPayableAccount) {
    const { data: entries } = await supabase
      .from("teller_journal_entries")
      .select("id")
      .eq("organization_id", organizationId)
      .lte("entry_date", periodEnd);
    const entryIds = (entries ?? []).map((e) => e.id as string);
    if (entryIds.length) {
      const { data: lines } = await supabase
        .from("teller_journal_lines")
        .select("debit, credit")
        .in("entry_id", entryIds)
        .eq("account_id", taxPayableAccount.id as string);
      for (const line of lines ?? []) {
        salesTaxPayableGlBalance += asNumber(line.credit) - asNumber(line.debit);
      }
    }
  }

  const invoices = (documents ?? [])
    .filter((d) => d.kind === "invoice")
    .map((d) => ({
      issueDate: d.issue_date as string,
      subtotal: asNumber(d.subtotal),
      tax: asNumber(d.tax),
      jurisdiction: null,
      taxMode: orgTaxMode ?? null,
      status: d.status as string,
      kind: d.kind as string,
    }));

  const creditMemos = (documents ?? [])
    .filter((d) => d.kind === "credit_memo")
    .map((d) => ({
      issueDate: d.issue_date as string,
      subtotal: asNumber(d.subtotal),
      tax: asNumber(d.tax),
      jurisdiction: null,
      taxMode: orgTaxMode ?? null,
      status: d.status as string,
      kind: d.kind as string,
    }));

  const report = buildSalesTaxSummary({
    invoices,
    creditMemos,
    periodStart,
    periodEnd,
    salesTaxPayableGlBalance,
    orgTaxMode,
  });

  return (
    <div className="space-y-6">
      <header className="page-header">
        <Link href={routes.accounting} className="text-sm text-muted">
          ← Accounting
        </Link>
        <h1 className="mt-2">Sales tax summary</h1>
        <p className="text-muted">
          {range.label} · review only — no filing or remittance
        </p>
      </header>

      {report.configurationReviewRequired ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>CONFIGURATION REVIEW REQUIRED</strong> — jurisdiction or tax rules are incomplete.
        </p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-4">
        <div className="card p-4">
          <p className="text-sm text-muted">Net tax liability</p>
          <p className="font-ledger mt-1 text-xl">{money(report.reportedNetLiability)}</p>
        </div>
        <div className="card p-4">
          <p className="text-sm text-muted">Sales tax payable (GL)</p>
          <p className="font-ledger mt-1 text-xl">{money(report.salesTaxPayableGlBalance)}</p>
        </div>
        <div className="card p-4">
          <p className="text-sm text-muted">Difference</p>
          <p className="font-ledger mt-1 text-xl">{money(report.difference)}</p>
        </div>
        <div className="card p-4">
          <p className="text-sm text-muted">Filing</p>
          <p className="font-ledger mt-1 text-xl">Not enabled</p>
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Period</th>
              <th>Jurisdiction</th>
              <th className="text-right">Taxable sales</th>
              <th className="text-right">Non-taxable</th>
              <th className="text-right">Tax collected</th>
              <th className="text-right">Credits/refunds</th>
              <th className="text-right">Net liability</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => (
              <tr key={row.jurisdiction}>
                <td>{row.period}</td>
                <td>{row.jurisdiction}</td>
                <td className="text-right font-tabular">{money(row.taxableSales)}</td>
                <td className="text-right font-tabular">{money(row.nonTaxableSales)}</td>
                <td className="text-right font-tabular">{money(row.taxCollected)}</td>
                <td className="text-right font-tabular">{money(row.creditsRefunds)}</td>
                <td className="text-right font-tabular">{money(row.netLiability)}</td>
                <td>
                  {row.configurationReviewRequired ? (
                    <span className="text-xs uppercase tracking-wide text-amber-800">
                      Config review
                    </span>
                  ) : (
                    "OK"
                  )}
                </td>
              </tr>
            ))}
            {!report.rows.length ? (
              <tr>
                <td colSpan={8} className="py-6 text-center text-muted">
                  No taxable activity in this period.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
