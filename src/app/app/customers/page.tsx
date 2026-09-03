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
      <header className="page-header">
        <h1>{heading}</h1>
      </header>
      <CustomerForm singular={label(session.settings, "customerSingular", "Customer")} />
      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).length === 0 ? (
              <tr>
                <td colSpan={3} className="text-muted">
                  None yet. Add one manually or import from Settings → Integrations.
                </td>
              </tr>
            ) : (
              (data ?? []).map((row) => (
                <tr key={row.id}>
                  <td className="font-medium">{row.name}</td>
                  <td>{row.email || "—"}</td>
                  <td className="text-muted">
                    {row.external_source === "quoter" ? "Integration" : "Manual"}
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
