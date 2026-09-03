import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDate, money } from "@/lib/format";
import { routes } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function InvoicesPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  const supabase = await createClient();

  const { data } = await supabase
    .from("teller_documents")
    .select("id, number, status, total, issue_date, party_id, external_source")
    .eq("organization_id", session.organization.id)
    .eq("kind", "invoice")
    .order("created_at", { ascending: false });

  const { data: parties } = await supabase
    .from("teller_parties")
    .select("id, name")
    .eq("organization_id", session.organization.id);
  const names = new Map((parties ?? []).map((row) => [row.id, row.name]));

  return (
    <div>
      <div className="flex items-center justify-between">
        <header className="page-header mb-0">
          <h1>Invoices</h1>
        </header>
        <Link href={routes.invoiceNew} className="btn btn-primary">
          New invoice
        </Link>
      </div>
      <div className="card mt-6 overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Number</th>
              <th>Customer</th>
              <th>Date</th>
              <th>Status</th>
              <th className="text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).length === 0 ? (
              <tr>
                <td colSpan={5} className="text-muted">
                  No invoices yet.
                </td>
              </tr>
            ) : (
              (data ?? []).map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link href={`${routes.invoices}/${row.id}`} className="font-medium text-ink">
                      {row.number}
                    </Link>
                    {row.external_source === "quoter" ? (
                      <span className="ml-2 text-xs text-accent">Imported</span>
                    ) : null}
                  </td>
                  <td>{row.party_id ? names.get(row.party_id) : "—"}</td>
                  <td>{formatDate(row.issue_date)}</td>
                  <td>
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="text-right font-tabular">{money(row.total)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
