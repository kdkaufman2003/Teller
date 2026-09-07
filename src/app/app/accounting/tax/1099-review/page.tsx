import Link from "next/link";
import { build1099ReviewReport } from "@/lib/accounting/tax-1099-review";
import { money } from "@/lib/format";
import { routes } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

type PageProps = {
  searchParams: Promise<{ year?: string }>;
};

export default async function Tax1099ReviewPage({ searchParams }: PageProps) {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  const params = await searchParams;
  const calendarYear = Number(params.year ?? new Date().getFullYear());
  const supabase = await createClient();
  const organizationId = session.organization.id;
  const isAdmin = session.profile?.role === "owner" || session.profile?.role === "admin";

  const { data: vendors } = await supabase
    .from("teller_parties")
    .select(
      "id, name, legal_name, eligible_1099, form_1099_category, w9_received, vendor_metadata, entity_type",
    )
    .eq("organization_id", organizationId)
    .eq("role", "vendor");

  const vendorMap = new Map((vendors ?? []).map((v) => [v.id as string, v]));

  const { data: payments } = await supabase
    .from("teller_payments")
    .select("id, party_id, amount, payment_date, payment_method, payment_type, status")
    .eq("organization_id", organizationId)
    .eq("status", "posted")
    .eq("payment_type", "bill_payment");

  const events = (payments ?? []).flatMap((payment) => {
    const vendor = payment.party_id ? vendorMap.get(payment.party_id as string) : null;
    if (!vendor) return [];
    const metadata = (vendor.vendor_metadata as Record<string, unknown> | null) ?? {};
    return [
      {
        vendorId: vendor.id as string,
        vendorName: vendor.name as string,
        legalName: (vendor.legal_name as string) || (vendor.name as string),
        eligible1099: Boolean(vendor.eligible_1099),
        form1099Category: (vendor.form_1099_category as string) ?? "",
        w9Received: Boolean(vendor.w9_received),
        entityType: (vendor.entity_type as string) ?? "",
        hasTin: isAdmin && Boolean(metadata.tax_id_reference),
        paymentDate: payment.payment_date as string,
        amount: Number(payment.amount),
        paymentMethod: payment.payment_method as string | null,
        paymentType: payment.payment_type as string,
      },
    ];
  });

  const report = build1099ReviewReport(events, calendarYear);

  return (
    <div className="space-y-6">
      <header className="page-header">
        <Link href={routes.accounting} className="text-sm text-muted">
          ← Accounting
        </Link>
        <h1 className="mt-2">1099 review</h1>
        <p className="text-muted">
          Tax readiness only — not filing. Calendar year {calendarYear}. TIN values are never shown
          in default exports.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-4">
        <div className="card p-4">
          <p className="text-xs uppercase tracking-[0.14em] text-muted">Likely reportable</p>
          <p className="font-ledger mt-2 text-xl">{money(report.totals.likelyReportable)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs uppercase tracking-[0.14em] text-muted">Excluded</p>
          <p className="font-ledger mt-2 text-xl">{money(report.totals.excluded)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs uppercase tracking-[0.14em] text-muted">Needs review</p>
          <p className="font-ledger mt-2 text-xl">{money(report.totals.needsReview)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs uppercase tracking-[0.14em] text-muted">Total payments</p>
          <p className="font-ledger mt-2 text-xl">{money(report.totals.totalPayments)}</p>
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Vendor</th>
              <th>Eligible</th>
              <th>W-9</th>
              <th>TIN</th>
              <th>Likely reportable</th>
              <th>Excluded</th>
              <th>Needs review</th>
              <th>Review reasons</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => (
              <tr key={row.vendorId}>
                <td>
                  <Link href={routes.vendors + "/" + row.vendorId} className="underline">
                    {row.vendorName}
                  </Link>
                </td>
                <td>{row.eligible1099 ? "Yes" : "No"}</td>
                <td>{row.w9Received ? "Received" : "Missing"}</td>
                <td>{isAdmin ? row.tinStatus : "Restricted"}</td>
                <td>{money(row.likelyReportable)}</td>
                <td>{money(row.excluded)}</td>
                <td>{money(row.needsReview)}</td>
                <td className="text-sm text-muted">{row.reviewReasons.join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
