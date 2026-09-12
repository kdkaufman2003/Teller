import Link from "next/link";
import { resolveLegalEntityId } from "@/lib/accounting/post";
import { buildTrialBalance } from "@/lib/accounting/trial-balance";
import { endOfMonth } from "@/lib/accounting/periods";
import { money } from "@/lib/format";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { routes } from "@/lib/routes";
import { redirect } from "next/navigation";

type PageProps = {
  searchParams: Promise<{ periodEnd?: string; periodStart?: string }>;
};

export default async function TrialBalancePage({ searchParams }: PageProps) {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  const params = await searchParams;
  const today = new Date();
  const defaultEnd = endOfMonth(today.getFullYear(), today.getMonth() + 1);
  const periodEnd = (params.periodEnd ?? defaultEnd).slice(0, 10);
  const periodStart = params.periodStart?.slice(0, 10) ?? `${periodEnd.slice(0, 8)}01`;

  const supabase = await createClient();
  const organizationId = session.organization.id;
  const legalEntityId = await resolveLegalEntityId(
    supabase,
    organizationId,
    session.profile?.active_legal_entity_id ?? null,
  );
  const report = await buildTrialBalance(supabase, organizationId, {
    legalEntityId,
    periodStart,
    periodEnd,
  });

  return (
    <div className="space-y-6">
      <header className="page-header">
        <Link href={routes.accounting} className="text-sm text-muted">
          ← Accounting
        </Link>
        <h1 className="mt-2">Trial balance</h1>
        <p className="text-muted">
          {periodStart} through {periodEnd}
          {report.balanced ? " · balanced" : " · out of balance"}
        </p>
      </header>

      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Account</th>
              <th className="text-right">Unadj. debit</th>
              <th className="text-right">Unadj. credit</th>
              <th className="text-right">Adj. debit</th>
              <th className="text-right">Adj. credit</th>
              <th className="text-right">Adjusted debit</th>
              <th className="text-right">Adjusted credit</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => (
              <tr key={row.accountId}>
                <td>
                  {row.code} {row.name}
                </td>
                <td className="text-right font-tabular">{money(row.unadjustedDebit)}</td>
                <td className="text-right font-tabular">{money(row.unadjustedCredit)}</td>
                <td className="text-right font-tabular">{money(row.adjustmentDebit)}</td>
                <td className="text-right font-tabular">{money(row.adjustmentCredit)}</td>
                <td className="text-right font-tabular">{money(row.adjustedDebit)}</td>
                <td className="text-right font-tabular">{money(row.adjustedCredit)}</td>
              </tr>
            ))}
            {!report.rows.length ? (
              <tr>
                <td colSpan={7} className="text-muted py-6 text-center">
                  No activity for this period.
                </td>
              </tr>
            ) : null}
          </tbody>
          <tfoot>
            <tr className="font-medium">
              <td>Totals</td>
              <td className="text-right font-tabular">{money(report.totals.unadjustedDebit)}</td>
              <td className="text-right font-tabular">{money(report.totals.unadjustedCredit)}</td>
              <td className="text-right font-tabular">{money(report.totals.adjustmentDebit)}</td>
              <td className="text-right font-tabular">{money(report.totals.adjustmentCredit)}</td>
              <td className="text-right font-tabular">{money(report.totals.adjustedDebit)}</td>
              <td className="text-right font-tabular">{money(report.totals.adjustedCredit)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
