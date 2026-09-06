import Link from "next/link";
import { BillPanel } from "@/components/BillPanel";
import { StatusBadge } from "@/components/StatusBadge";
import {
  authoritativeDocumentRemaining,
  enrichDocumentsWithAuthoritativePaid,
} from "@/lib/accounting/balances";
import { batchCreditsAppliedToDocumentsMap } from "@/lib/accounting/balances";
import { asNumber, formatDate, money } from "@/lib/format";
import { billPath, routes } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function BillsPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  const supabase = await createClient();
  const organizationId = session.organization.id;

  const [{ data }, { data: accounts }, { data: parties }] = await Promise.all([
    supabase
      .from("teller_documents")
      .select("id, number, status, total, issue_date, due_date, memo, party_id, reference_number")
      .eq("organization_id", organizationId)
      .eq("kind", "bill")
      .order("issue_date", { ascending: false }),
    supabase
      .from("teller_accounts")
      .select("id, code, name, type")
      .eq("organization_id", organizationId)
      .in("type", ["expense", "cogs", "asset"])
      .order("code"),
    supabase
      .from("teller_parties")
      .select("id, name")
      .eq("organization_id", organizationId)
      .eq("kind", "vendor")
      .order("name"),
  ]);

  const enriched = await enrichDocumentsWithAuthoritativePaid(supabase, organizationId, data ?? []);
  const creditsMap = await batchCreditsAppliedToDocumentsMap(
    supabase,
    organizationId,
    enriched.map((row) => row.id),
  );
  const names = new Map((parties ?? []).map((row) => [row.id, row.name]));

  return (
    <div className="space-y-6">
      <header className="page-header">
        <h1>Bills</h1>
        <p>Vendor amounts owed — post to AP, then pay when due.</p>
      </header>
      <BillPanel accounts={accounts ?? []} vendors={parties ?? []} />
      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Number</th>
              <th>Vendor</th>
              <th>Vendor #</th>
              <th>Date</th>
              <th>Due</th>
              <th>Status</th>
              <th className="text-right">Total</th>
              <th className="text-right">Remaining</th>
            </tr>
          </thead>
          <tbody>
            {await Promise.all(
              enriched.map(async (row) => {
                const credits = creditsMap.get(row.id) ?? 0;
                const remaining = await authoritativeDocumentRemaining(
                  supabase,
                  organizationId,
                  row.id,
                  asNumber(row.total),
                );
                return (
                  <tr key={row.id}>
                    <td>
                      <Link href={billPath(row.id)} className="font-medium">
                        {row.number}
                      </Link>
                    </td>
                    <td>{row.party_id ? names.get(row.party_id) : row.memo || "—"}</td>
                    <td className="text-muted">{row.reference_number || "—"}</td>
                    <td>{formatDate(row.issue_date)}</td>
                    <td>{row.due_date ? formatDate(row.due_date) : "—"}</td>
                    <td>
                      <StatusBadge status={row.status} />
                    </td>
                    <td className="text-right font-tabular">{money(row.total)}</td>
                    <td className="text-right font-tabular">
                      {remaining > 0.009 ? money(remaining) : credits > 0 ? "—" : money(0)}
                    </td>
                  </tr>
                );
              }),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
