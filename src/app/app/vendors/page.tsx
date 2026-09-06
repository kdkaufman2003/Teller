import Link from "next/link";
import { VendorForm } from "@/components/VendorForm";
import { VendorListTable, type VendorRow } from "@/components/VendorListTable";
import {
  authoritativeDocumentRemaining,
  enrichDocumentsWithAuthoritativePaid,
} from "@/lib/accounting/balances";
import { sumCreditsAppliedFromDocument } from "@/lib/accounting/document-allocations";
import { asNumber, todayISO } from "@/lib/format";
import { routes } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function VendorsPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  const supabase = await createClient();
  const organizationId = session.organization.id;
  const asOf = todayISO();

  const [{ data: vendors }, { data: bills }, { data: credits }, { data: payments }] =
    await Promise.all([
      supabase
        .from("teller_parties")
        .select("id, name, email, party_status, payment_terms, created_at")
        .eq("organization_id", organizationId)
        .in("kind", ["vendor", "both"])
        .order("name"),
      supabase
        .from("teller_documents")
        .select("id, party_id, total, status, due_date, issue_date")
        .eq("organization_id", organizationId)
        .eq("kind", "bill")
        .in("status", ["open", "partially_paid"]),
      supabase
        .from("teller_documents")
        .select("id, party_id, total, status")
        .eq("organization_id", organizationId)
        .eq("kind", "vendor_credit")
        .in("status", ["open", "partially_applied"]),
      supabase
        .from("teller_payments")
        .select("party_id, payment_date, amount")
        .eq("organization_id", organizationId)
        .eq("payment_type", "bill_payment")
        .order("payment_date", { ascending: false })
        .limit(200),
    ]);

  const enrichedBills = await enrichDocumentsWithAuthoritativePaid(
    supabase,
    organizationId,
    bills ?? [],
  );

  const rows: VendorRow[] = await Promise.all(
    (vendors ?? []).map(async (vendor) => {
      const vendorBills = enrichedBills.filter((bill) => bill.party_id === vendor.id);
      let openBalance = 0;
      let overdueBalance = 0;
      for (const bill of vendorBills) {
        const remaining = await authoritativeDocumentRemaining(
          supabase,
          organizationId,
          bill.id as string,
          asNumber(bill.total),
        );
        if (remaining <= 0.009) continue;
        openBalance += remaining;
        const due = (bill.due_date as string) || (bill.issue_date as string) || asOf;
        if (due < asOf) overdueBalance += remaining;
      }

      let availableCredits = 0;
      for (const credit of (credits ?? []).filter((row) => row.party_id === vendor.id)) {
        const applied = await sumCreditsAppliedFromDocument(
          supabase,
          organizationId,
          credit.id as string,
        );
        const remaining = asNumber(credit.total) - applied;
        if (remaining > 0.009) availableCredits += remaining;
      }

      const recentPayment = (payments ?? []).find((row) => row.party_id === vendor.id);
      const recentActivity = recentPayment
        ? `Payment ${asNumber(recentPayment.amount).toFixed(2)} on ${recentPayment.payment_date}`
        : "";

      return {
        id: vendor.id as string,
        name: vendor.name as string,
        email: (vendor.email as string) || "",
        party_status: (vendor.party_status as string) || "active",
        payment_terms: (vendor.payment_terms as string) || "",
        openBalance,
        overdueBalance,
        availableCredits,
        recentActivity,
      };
    }),
  );

  return (
    <div className="space-y-6">
      <header className="page-header">
        <h1>Vendors</h1>
        <p>Vendor profiles, open AP, credits, and purchasing activity.</p>
      </header>
      <VendorForm />
      <VendorListTable vendors={rows} />
    </div>
  );
}
