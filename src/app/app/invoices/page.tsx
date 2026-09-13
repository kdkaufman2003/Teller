import Link from "next/link";
import { CompanyContextHeader } from "@/components/legal-entity/CompanyContextHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  documentRemainingBalance,
  enrichDocumentsWithAuthoritativePaid,
} from "@/lib/accounting/balances";
import { resolveLegalEntityId } from "@/lib/accounting/post";
import { asNumber, formatDate, money } from "@/lib/format";
import { routes } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function InvoicesPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  const supabase = await createClient();
  const organizationId = session.organization.id;
  const legalEntityId = await resolveLegalEntityId(
    supabase,
    organizationId,
    session.profile?.active_legal_entity_id ?? null,
  );

  const { data } = await supabase
    .from("teller_documents")
    .select("id, number, status, total, amount_paid, issue_date, party_id, external_source")
    .eq("organization_id", organizationId)
    .eq("legal_entity_id", legalEntityId)
    .eq("kind", "invoice")
    .order("created_at", { ascending: false });

  const { data: parties } = await supabase
    .from("teller_parties")
    .select("id, name")
    .eq("organization_id", organizationId);
  const names = new Map((parties ?? []).map((row) => [row.id, row.name]));
  const enriched = await enrichDocumentsWithAuthoritativePaid(supabase, organizationId, data ?? []);

  return (
    <div>
      <CompanyContextHeader activeLegalEntity={session.activeLegalEntity} />
      <div className="flex items-center justify-between">
        <header className="page-header mb-0">
          <h1>Money in</h1>
          <p className="text-sm text-muted">Invoices and customer payments for this company</p>
        </header>
        <Link href={routes.invoiceNew} className="btn btn-primary">
          New invoice
        </Link>
      </div>
      {(data ?? []).length === 0 ? (
        <div className="mt-6">
          <EmptyState
            title="No invoices yet"
            description="Create an invoice when you bill a customer. Payments and credits reduce the amount still owed."
            actionHref={routes.invoiceNew}
            actionLabel="Create first invoice"
          />
        </div>
      ) : (
        <div className="card mt-6 overflow-hidden">
          <table className="data-table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Customer</th>
                <th>Date</th>
                <th>Status</th>
                <th className="text-right">Total</th>
                <th className="text-right">Remaining</th>
              </tr>
            </thead>
            <tbody>
              {enriched.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link href={`${routes.invoices}/${row.id}`} className="font-medium">
                      {row.number}
                    </Link>
                    {(row.external_source === "hfac" || row.external_source === "quoter") ? (
                      <span className="ml-2 text-xs text-brass-deep">HFAC</span>
                    ) : null}
                  </td>
                  <td>{row.party_id ? names.get(row.party_id) : "—"}</td>
                  <td>{formatDate(row.issue_date)}</td>
                  <td>
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="text-right font-tabular">{money(row.total)}</td>
                  <td className="text-right font-tabular">
                    {money(
                      documentRemainingBalance(asNumber(row.total), asNumber(row.amount_paid)),
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
