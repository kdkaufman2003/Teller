import Link from "next/link";
import { CompanyContextHeader } from "@/components/legal-entity/CompanyContextHeader";
import { loadCompaniesOverview } from "@/lib/legal-entity/companies-overview";
import { listAccessibleLegalEntities } from "@/lib/accounting/legal-entity/active-context";
import { money } from "@/lib/format";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { routes } from "@/lib/routes";
import { redirect } from "next/navigation";

export default async function CompaniesOverviewPage() {
  const session = await getSessionContext();
  if (!session?.organization || !session.profile) redirect(routes.setup);

  const supabase = await createClient();
  const organizationId = session.organization.id;
  const asOf = new Date().toISOString().slice(0, 10);

  const entities = await listAccessibleLegalEntities(supabase, organizationId, {
    userId: session.profile.id,
    role: session.profile.role,
  });

  if (entities.length <= 1) {
    return (
      <div className="space-y-6">
        <CompanyContextHeader scope="all_companies" />
        <div className="card p-6">
          <h1 className="font-ledger text-2xl text-navy">All Companies</h1>
          <p className="mt-2 text-muted">
            Your books are currently set up for one company. Add another company in Settings when
            you are ready to manage multiple sets of books.
          </p>
          <Link href={routes.entitySettings} className="btn btn-secondary mt-4 inline-block">
            Manage companies
          </Link>
        </div>
      </div>
    );
  }

  const rows = await loadCompaniesOverview(supabase, organizationId, entities, asOf);

  return (
    <div className="space-y-6">
      <CompanyContextHeader
        scope="all_companies"
        subtitle="Pre-elimination company totals. Use Consolidated Reports for elimination-aware views."
      />
      <header className="page-header">
        <h1>All Companies</h1>
        <p className="text-muted">Compare cash, receivables, payables, and books status by company.</p>
      </header>
      <div className="flex flex-wrap gap-3">
        <Link href={routes.reportsConsolidated} className="btn btn-secondary text-sm">
          Consolidated reports
        </Link>
        <Link href={routes.entitySettings} className="btn btn-ghost text-sm">
          Manage companies
        </Link>
      </div>
      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Company</th>
              <th className="text-right">Cash</th>
              <th className="text-right">Receivables</th>
              <th className="text-right">Payables</th>
              <th className="text-right">Revenue YTD</th>
              <th className="text-right">Net income YTD</th>
              <th>Books through</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.legalEntityId}>
                <td>
                  <span className="font-medium">{row.name}</span>
                  <span className="ml-2 text-xs text-muted">{row.entityCode}</span>
                  {row.isDefault ? (
                    <span className="ml-2 rounded bg-rule px-1.5 py-0.5 text-[10px] uppercase text-muted">
                      Default
                    </span>
                  ) : null}
                </td>
                <td className="text-right font-tabular">{money(row.cash)}</td>
                <td className="text-right font-tabular">{money(row.receivables)}</td>
                <td className="text-right font-tabular">{money(row.payables)}</td>
                <td className="text-right font-tabular">{money(row.revenue)}</td>
                <td className="text-right font-tabular">{money(row.netIncome)}</td>
                <td className="text-sm text-muted">{row.booksClosedThrough ?? "Open"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
