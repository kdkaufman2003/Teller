import { ExpenseForm } from "@/components/ExpenseForm";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDate, money } from "@/lib/format";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { routes } from "@/lib/routes";
import { redirect } from "next/navigation";

export default async function ExpensesPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  const supabase = await createClient();

  const [{ data }, { data: accounts }, { data: parties }] = await Promise.all([
    supabase
      .from("teller_documents")
      .select("id, number, status, total, issue_date, memo, party_id")
      .eq("organization_id", session.organization.id)
      .eq("kind", "expense")
      .order("issue_date", { ascending: false }),
    supabase
      .from("teller_accounts")
      .select("id, code, name, type")
      .eq("organization_id", session.organization.id)
      .in("type", ["expense", "cogs"])
      .order("code"),
    supabase
      .from("teller_parties")
      .select("id, name")
      .eq("organization_id", session.organization.id),
  ]);

  const names = new Map((parties ?? []).map((row) => [row.id, row.name]));

  return (
    <div className="space-y-6">
      <h1 className="font-ledger text-4xl text-navy">Expenses</h1>
      <ExpenseForm accounts={accounts ?? []} />
      <div className="card overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-paper text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Number</th>
              <th className="px-4 py-3 font-medium">Vendor</th>
              <th className="px-4 py-3 font-medium">Date</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((row) => (
              <tr key={row.id} className="border-t border-rule">
                <td className="px-4 py-3">{row.number}</td>
                <td className="px-4 py-3">
                  {row.party_id ? names.get(row.party_id) : row.memo || "—"}
                </td>
                <td className="px-4 py-3">{formatDate(row.issue_date)}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={row.status} />
                </td>
                <td className="px-4 py-3 text-right font-tabular">{money(row.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
