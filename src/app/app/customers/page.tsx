import { CustomerForm } from "@/components/CustomerForm";
import { label } from "@/lib/session";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { routes } from "@/lib/routes";
import { redirect } from "next/navigation";

export default async function CustomersPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  const supabase = await createClient();
  const heading = label(session.settings, "customer", "Customers");

  const { data } = await supabase
    .from("teller_parties")
    .select("*")
    .eq("organization_id", session.organization.id)
    .in("kind", ["customer", "both"])
    .order("name");

  return (
    <div className="space-y-6">
      <h1 className="font-ledger text-4xl text-navy">{heading}</h1>
      <CustomerForm singular={label(session.settings, "customerSingular", "Customer")} />
      <div className="card overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-paper text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Email</th>
              <th className="px-4 py-3 font-medium">Source</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-muted">
                  None yet. Add one or sync Quoter dealers.
                </td>
              </tr>
            ) : (
              (data ?? []).map((row) => (
                <tr key={row.id} className="border-t border-rule">
                  <td className="px-4 py-3 font-medium">{row.name}</td>
                  <td className="px-4 py-3">{row.email || "—"}</td>
                  <td className="px-4 py-3 text-muted">
                    {row.external_source === "quoter" ? "Quoter dealer" : "Manual"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
