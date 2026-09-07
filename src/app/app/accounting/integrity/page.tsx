import Link from "next/link";
import { runFinancialIntegrityChecks } from "@/lib/accounting/integrity";
import { reconcileSubledgersToGl } from "@/lib/accounting/subledger";
import { reconcileDepositsToGl } from "@/lib/accounting/deposit-reconciliation";
import { buildOrgJobGlReconciliation } from "@/lib/accounting/org-job-reconciliation";
import { booksClosedThrough } from "@/lib/accounting/periods";
import { money } from "@/lib/format";
import { routes } from "@/lib/routes";
import { getSessionContext, hasModule } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function AccountingIntegrityPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  const supabase = await createClient();
  const organizationId = session.organization.id;
  const showJobs = hasModule(session.settings, "jobs");
  const showAssets = hasModule(session.settings, "fixed_assets");

  const [integrityIssues, subledger, depositReconciliation, closes] = await Promise.all([
    runFinancialIntegrityChecks(supabase, organizationId),
    reconcileSubledgersToGl(supabase, organizationId),
    reconcileDepositsToGl(supabase, organizationId),
    supabase
      .from("teller_period_closes")
      .select("period_end, effective_closed_through, closed_at, event_type")
      .eq("organization_id", organizationId)
      .order("closed_at", { ascending: false }),
  ]);

  const jobBridge = showJobs
    ? await buildOrgJobGlReconciliation(supabase, organizationId, new Date().toISOString().slice(0, 10))
    : null;

  const closedThrough = booksClosedThrough(closes.data ?? []);

  return (
    <div className="space-y-6">
      <header className="page-header">
        <Link href={routes.accounting} className="text-sm text-muted">
          ← Accounting
        </Link>
        <h1 className="mt-2">Accounting integrity</h1>
        <p className="text-muted">
          Subledger reconciliation, journal health, and period status — read-only.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="card p-4">
          <p className="text-xs uppercase tracking-[0.14em] text-muted">Integrity issues</p>
          <p className="font-ledger mt-2 text-2xl text-navy">{integrityIssues.length}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs uppercase tracking-[0.14em] text-muted">Books closed through</p>
          <p className="font-ledger mt-2 text-2xl text-navy">{closedThrough ?? "Not closed"}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs uppercase tracking-[0.14em] text-muted">Deposit reconciliation</p>
          <p className="font-ledger mt-2 text-2xl text-navy">
            {depositReconciliation?.consistent ? "Consistent" : "Review"}
          </p>
        </div>
      </div>

      {integrityIssues.length ? (
        <div className="card overflow-hidden">
          <table className="data-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {integrityIssues.map((issue) => (
                <tr key={`${issue.code}-${issue.resourceId}`}>
                  <td>{issue.code}</td>
                  <td>{issue.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-muted">No integrity issues detected.</p>
      )}

      <div className="card p-4 space-y-3">
        <h2 className="font-medium text-navy">Subledger reconciliation</h2>
        {subledger.map((row) => (
          <div key={row.side} className="flex justify-between text-sm">
            <span>{row.side.toUpperCase()}</span>
            <span className={row.consistent ? "text-green-700" : "text-amber-700"}>
              GL {money(row.glControlBalance)} · Subledger {money(row.subledgerOpenBalance)} ·{" "}
              {row.consistent ? "OK" : "Mismatch"}
            </span>
          </div>
        ))}
      </div>

      {jobBridge ? (
        <div className="card p-4">
          <h2 className="font-medium text-navy">Job GL bridge</h2>
          <p className="mt-2 text-sm text-muted">
            Revenue unassigned: {money(jobBridge.revenue.unassigned)} · Direct cost unassigned:{" "}
            {money(jobBridge.directCost.unassigned)}
          </p>
        </div>
      ) : null}

      {showAssets ? (
        <p className="text-sm text-muted">
          Fixed asset reconciliation available on{" "}
          <Link href={routes.assetsReconciliation} className="underline">
            asset reconciliation
          </Link>
          .
        </p>
      ) : null}
    </div>
  );
}
