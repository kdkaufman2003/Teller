import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDate, money } from "@/lib/format";
import { purchaseOrderPath, routes } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function PurchaseOrdersPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  const supabase = await createClient();
  const organizationId = session.organization.id;

  const { data } = await supabase
    .from("teller_purchase_orders")
    .select("id, number, status, issue_date, expected_date, total, party_id, job_id")
    .eq("organization_id", organizationId)
    .order("issue_date", { ascending: false });

  const partyIds = [...new Set((data ?? []).map((row) => row.party_id))];
  const { data: parties } = partyIds.length
    ? await supabase.from("teller_parties").select("id, name").in("id", partyIds)
    : { data: [] };
  const partyNames = new Map((parties ?? []).map((row) => [row.id, row.name]));

  return (
    <div className="space-y-6">
      <header className="page-header flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1>Purchase orders</h1>
          <p>Non-GL purchasing — receiving and billing link to AP separately.</p>
        </div>
        <Link href={`${routes.purchaseOrders}/new`} className="btn btn-brass">
          New PO
        </Link>
      </header>
      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>PO #</th>
              <th>Vendor</th>
              <th>Issue date</th>
              <th>Expected</th>
              <th>Status</th>
              <th className="text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).length === 0 ? (
              <tr>
                <td colSpan={6} className="text-muted">
                  No purchase orders yet.
                </td>
              </tr>
            ) : (
              (data ?? []).map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link href={purchaseOrderPath(row.id as string)} className="font-medium">
                      {row.number}
                    </Link>
                  </td>
                  <td>{partyNames.get(row.party_id) || "—"}</td>
                  <td>{formatDate(row.issue_date)}</td>
                  <td>{row.expected_date ? formatDate(row.expected_date) : "—"}</td>
                  <td>
                    <StatusBadge status={row.status as string} />
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
