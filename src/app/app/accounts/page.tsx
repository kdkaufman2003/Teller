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
      <h1 className="font-ledger text-4xl text-navy">Chart of accounts</h1>
      <p className="mt-2 text-sm text-muted">
        Seeded from the {session.organization.industry_id} industry pack and your
        setup answers.
      </p>
      <div className="card mt-6 overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-paper text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Code</th>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Type</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((account) => (
              <tr key={account.id} className="border-t border-rule">
                <td className="px-4 py-3 font-tabular">{account.code}</td>
                <td className="px-4 py-3">{account.name}</td>
                <td className="px-4 py-3 text-muted">{titleCase(account.type)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
