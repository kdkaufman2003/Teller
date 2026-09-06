import Link from "next/link";
import { MultiBillPayForm } from "@/components/MultiBillPayForm";
import { routes } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function BillPayPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  const supabase = await createClient();

  const { data: vendors } = await supabase
    .from("teller_parties")
    .select("id, name")
    .eq("organization_id", session.organization.id)
    .in("kind", ["vendor", "both"])
    .order("name");

  return (
    <div className="space-y-6">
      <div>
        <Link href={routes.bills} className="text-sm text-muted">
          ← Bills
        </Link>
        <h1 className="font-ledger mt-2 text-4xl text-navy">Pay bills</h1>
        <p className="text-muted">One payment, multiple bills — single Dr AP / Cr Cash journal.</p>
      </div>
      <MultiBillPayForm vendors={vendors ?? []} />
    </div>
  );
}
