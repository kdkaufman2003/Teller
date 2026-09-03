import { titleCase } from "@/lib/format";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { routes } from "@/lib/routes";
import { redirect } from "next/navigation";

export default async function AccountsPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  const supabase = await createClient();
  const { data } = await supabase
    .from("teller_accounts")
    .select("*")
    .eq("organization_id", session.organization.id)
    .order("code");

  return (
    <div>
      <header className="page-header">
        <h1>Chart of accounts</h1>
        <p>
          Seeded from the {session.organization.industry_id} industry pack and your
          setup answers.
        </p>
      </header>
      <div className="card mt-6 overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Type</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((account) => (
              <tr key={account.id}>
                <td className="font-tabular">{account.code}</td>
                <td>{account.name}</td>
                <td className="text-muted">{titleCase(account.type)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
