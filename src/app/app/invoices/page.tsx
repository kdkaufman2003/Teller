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
        <h1 className="font-ledger text-4xl text-navy">Invoices</h1>
        <Link href={routes.invoiceNew} className="btn btn-primary">
          New invoice
        </Link>
      </div>
      <div className="card mt-6 overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-paper text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Number</th>
              <th className="px-4 py-3 font-medium">Customer</th>
              <th className="px-4 py-3 font-medium">Date</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-muted">
                  No invoices yet.
                </td>
              </tr>
            ) : (
              (data ?? []).map((row) => (
                <tr key={row.id} className="border-t border-rule">
                  <td className="px-4 py-3">
                    <Link href={`${routes.invoices}/${row.id}`} className="font-medium">
                      {row.number}
                    </Link>
                    {row.external_source === "quoter" ? (
                      <span className="ml-2 text-xs text-brass-deep">Quoter</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    {row.party_id ? names.get(row.party_id) : "—"}
                  </td>
                  <td className="px-4 py-3">{formatDate(row.issue_date)}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="px-4 py-3 text-right font-tabular">{money(row.total)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
