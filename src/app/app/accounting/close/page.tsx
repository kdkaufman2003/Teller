import Link from "next/link";
import { resolveLegalEntityId } from "@/lib/accounting/post";
import { evaluateCloseReadiness } from "@/lib/accounting/close-readiness";
import {
  booksClosedThrough,
  nextCloseablePeriodEnd,
  recentMonthPeriods,
  type PeriodCloseRow,
} from "@/lib/accounting/periods";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import {
  accountingClosePeriodPath,
  routes,
} from "@/lib/routes";
import { redirect } from "next/navigation";

export default async function CloseDashboardPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  const supabase = await createClient();
  const organizationId = session.organization.id;
  const legalEntityId = await resolveLegalEntityId(
    supabase,
    organizationId,
    session.profile?.active_legal_entity_id ?? null,
  );

  const { data: closes } = await supabase
    .from("teller_period_closes")
    .select("id, period_end, notes, closed_at, closed_by, effective_closed_through")
    .eq("organization_id", organizationId)
    .eq("legal_entity_id", legalEntityId)
    .order("period_end", { ascending: false })
    .limit(24);

  const closeRows = (closes ?? []) as PeriodCloseRow[];
  const closedThrough = booksClosedThrough(closeRows);
  const nextClose = nextCloseablePeriodEnd(closedThrough);
  const periods = recentMonthPeriods(12, new Date(), closedThrough);

  const readiness = nextClose
    ? await evaluateCloseReadiness(supabase, organizationId, legalEntityId, nextClose)
    : null;

  return (
    <div className="space-y-6">
      <header className="page-header">
        <Link href={routes.accounting} className="text-sm text-muted">
          ← Accounting
        </Link>
        <h1 className="mt-2">Month-end close</h1>
        <p className="text-muted">Review readiness, blockers, and close periods in order.</p>
      </header>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="card p-4">
          <p className="text-xs uppercase tracking-[0.14em] text-muted">Books closed through</p>
          <p className="font-ledger mt-2 text-2xl text-navy">
            {closedThrough ?? "Not closed"}
          </p>
        </div>
        <div className="card p-4">
          <p className="text-xs uppercase tracking-[0.14em] text-muted">Next closeable period</p>
          <p className="font-ledger mt-2 text-2xl text-navy">{nextClose ?? "—"}</p>
        </div>
        {readiness ? (
          <div className="card p-4">
            <p className="text-xs uppercase tracking-[0.14em] text-muted">Close readiness</p>
            <p className="font-ledger mt-2 text-2xl capitalize text-navy">
              {readiness.status.replace(/_/g, " ")}
            </p>
            <p className="mt-1 text-sm text-muted">
              {readiness.blockerCount} blocker{readiness.blockerCount === 1 ? "" : "s"},{" "}
              {readiness.warningCount} warning{readiness.warningCount === 1 ? "" : "s"}
            </p>
          </div>
        ) : (
          <div className="card p-4">
            <p className="text-xs uppercase tracking-[0.14em] text-muted">Close readiness</p>
            <p className="mt-2 text-sm text-muted">No period ready to close yet.</p>
          </div>
        )}
      </div>

      {nextClose ? (
        <div className="flex flex-wrap gap-3">
          <Link
            href={accountingClosePeriodPath(nextClose.slice(0, 7))}
            className="btn btn-primary"
          >
            Review {nextClose.slice(0, 7)} close
          </Link>
          <Link
            href={`${routes.accountingTrialBalance}?periodEnd=${nextClose}`}
            className="btn"
          >
            Trial balance
          </Link>
          <Link href={routes.accountingAdjustments} className="btn">
            Adjustments
          </Link>
        </div>
      ) : null}

      <div className="card overflow-hidden">
        <div className="border-b px-4 py-3 font-medium">Recent periods</div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Period</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {periods.map((period) => (
              <tr key={period.key}>
                <td>{period.label}</td>
                <td className="capitalize">{period.status}</td>
                <td className="text-right">
                  <Link
                    href={accountingClosePeriodPath(period.key)}
                    className="text-sm text-sky hover:underline"
                  >
                    Details
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
