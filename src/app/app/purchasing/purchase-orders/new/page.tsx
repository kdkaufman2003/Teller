import Link from "next/link";
import { PurchaseOrderForm } from "@/components/PurchaseOrderForm";
import { routes } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function NewPurchaseOrderPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  const supabase = await createClient();
  const organizationId = session.organization.id;

  const [{ data: vendors }, { data: accounts }, { data: jobs }] = await Promise.all([
    supabase
      .from("teller_parties")
      .select("id, name")
      .eq("organization_id", organizationId)
      .in("kind", ["vendor", "both"])
      .order("name"),
    supabase
      .from("teller_accounts")
      .select("id, code, name")
      .eq("organization_id", organizationId)
      .in("type", ["expense", "cogs"])
      .order("code"),
    supabase
      .from("teller_jobs")
      .select("id, job_number, name")
      .eq("organization_id", organizationId)
      .order("job_number"),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <Link href={routes.purchaseOrders} className="text-sm text-muted">
          ← Purchase orders
        </Link>
        <h1 className="font-ledger mt-2 text-3xl text-navy">New purchase order</h1>
      </div>
      <PurchaseOrderForm
        vendors={vendors ?? []}
        accounts={accounts ?? []}
        jobs={jobs ?? []}
      />
    </div>
  );
}
