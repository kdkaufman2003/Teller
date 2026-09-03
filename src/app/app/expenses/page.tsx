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
      <header className="page-header">
        <h1>Expenses</h1>
      </header>
      <ExpenseForm accounts={accounts ?? []} />
      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Number</th>
              <th>Vendor</th>
              <th>Date</th>
              <th>Status</th>
              <th className="text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((row) => (
              <tr key={row.id}>
                <td>{row.number}</td>
                <td>{row.party_id ? names.get(row.party_id) : row.memo || "—"}</td>
                <td>{formatDate(row.issue_date)}</td>
                <td>
                  <StatusBadge status={row.status} />
                </td>
                <td className="text-right font-tabular">{money(row.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
