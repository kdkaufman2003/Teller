import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusBadge } from "@/components/StatusBadge";
import { canViewVendorTaxInfo } from "@/lib/auth/roles";
import {
  authoritativeDocumentRemaining,
  enrichDocumentsWithAuthoritativePaid,
} from "@/lib/accounting/balances";
import { sumCreditsAppliedFromDocument } from "@/lib/accounting/document-allocations";
import { asNumber, formatDate, money, todayISO } from "@/lib/format";
import { billPath, purchaseOrderPath, routes, vendorCreditPath } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export default async function VendorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSessionContext();
  if (!session?.organization) notFound();
  const { id } = await params;
  const supabase = await createClient();
  const organizationId = session.organization.id;
  const asOf = todayISO();
  const showTax = canViewVendorTaxInfo(session.profile?.role);

  const { data: vendor } = await supabase
    .from("teller_parties")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();
  if (!vendor) notFound();

  const [{ data: bills }, { data: credits }, { data: payments }, { data: pos }, { data: audit }] =
    await Promise.all([
      supabase
        .from("teller_documents")
        .select("id, number, status, total, due_date, issue_date")
        .eq("organization_id", organizationId)
        .eq("party_id", id)
        .eq("kind", "bill")
        .order("issue_date", { ascending: false })
        .limit(30),
      supabase
        .from("teller_documents")
        .select("id, number, status, total, issue_date")
        .eq("organization_id", organizationId)
        .eq("party_id", id)
        .eq("kind", "vendor_credit")
        .order("issue_date", { ascending: false }),
      supabase
        .from("teller_payments")
        .select("id, amount, payment_date, reference_number, status")
        .eq("organization_id", organizationId)
        .eq("party_id", id)
        .eq("payment_type", "bill_payment")
        .order("payment_date", { ascending: false })
        .limit(15),
      supabase
        .from("teller_purchase_orders")
        .select("id, number, status, total, issue_date")
        .eq("organization_id", organizationId)
        .eq("party_id", id)
        .order("issue_date", { ascending: false })
        .limit(15),
      supabase
        .from("teller_audit_events")
        .select("action, created_at, metadata")
        .eq("organization_id", organizationId)
        .eq("resource_kind", "vendor")
        .eq("resource_id", id)
        .order("created_at", { ascending: false })
        .limit(10),
    ]);

  const enriched = await enrichDocumentsWithAuthoritativePaid(supabase, organizationId, bills ?? []);
  const openBills = await Promise.all(
    enriched
      .filter((row) => row.status === "open" || row.status === "partially_paid" || row.status === "pending_approval")
      .map(async (row) => ({
        ...row,
        remaining: await authoritativeDocumentRemaining(
          supabase,
          organizationId,
          row.id as string,
          asNumber(row.total),
        ),
      })),
  );

  let unappliedCredits = 0;
  const creditRows = await Promise.all(
    (credits ?? []).map(async (credit) => {
      const applied = await sumCreditsAppliedFromDocument(
        supabase,
        organizationId,
        credit.id as string,
      );
      const remaining = asNumber(credit.total) - applied;
      if (remaining > 0.009) unappliedCredits += remaining;
      return { ...credit, remaining };
    }),
  );

  const overdue = openBills.reduce((sum, row) => {
    const due = (row.due_date as string) || (row.issue_date as string) || asOf;
    return due < asOf ? sum + row.remaining : sum;
  }, 0);

  const totalSpend = (bills ?? [])
    .filter((row) => row.status !== "void" && row.status !== "draft")
    .reduce((sum, row) => sum + asNumber(row.total), 0);

  const vendorMeta = showTax ? ((vendor.vendor_metadata ?? {}) as Record<string, unknown>) : {};

  return (
    <div className="space-y-6">
      <div>
        <Link href={routes.vendors} className="text-sm text-muted">
          ← Vendors
        </Link>
        <h1 className="font-ledger mt-2 text-4xl text-navy">{vendor.name}</h1>
        {vendor.email ? <p className="text-muted">{vendor.email}</p> : null}
      </div>

      <div className="card p-4 grid gap-4 md:grid-cols-2 lg:grid-cols-4 text-sm">
        <div>
          <p className="text-muted">Open AP</p>
          <p className="font-tabular text-lg">
            {money(openBills.reduce((sum, row) => sum + row.remaining, 0))}
          </p>
        </div>
        <div>
          <p className="text-muted">Overdue</p>
          <p className="font-tabular text-lg">{money(overdue)}</p>
        </div>
        <div>
          <p className="text-muted">Available credits</p>
          <p className="font-tabular text-lg">{money(unappliedCredits)}</p>
        </div>
        <div>
          <p className="text-muted">Total spend (posted bills)</p>
          <p className="font-tabular text-lg">{money(totalSpend)}</p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="card p-4 space-y-2 text-sm">
          <h2 className="font-medium">Contact & defaults</h2>
          <p>
            <span className="text-muted">Phone:</span> {vendor.phone || "—"}
          </p>
          <p>
            <span className="text-muted">Payment terms:</span> {vendor.payment_terms || "—"}
          </p>
          <p>
            <span className="text-muted">Status:</span>{" "}
            <span className="capitalize">{vendor.party_status || "active"}</span>
          </p>
          <p>
            <span className="text-muted">Category:</span> {vendor.vendor_category || "—"}
          </p>
        </div>
        <div className="card p-4 space-y-2 text-sm">
          <h2 className="font-medium">1099 / W-9</h2>
          <p>
            <span className="text-muted">1099 eligible:</span>{" "}
            {vendor.eligible_1099 ? "Yes" : "No"}
          </p>
          <p>
            <span className="text-muted">1099 category:</span> {vendor.form_1099_category || "—"}
          </p>
          <p>
            <span className="text-muted">W-9 received:</span>{" "}
            {vendor.w9_received ? `Yes${vendor.w9_received_at ? ` (${vendor.w9_received_at})` : ""}` : "No"}
          </p>
          {showTax && vendorMeta.tax_id_reference ? (
            <p>
              <span className="text-muted">Tax ID ref:</span> {String(vendorMeta.tax_id_reference)}
            </p>
          ) : null}
          {!showTax ? (
            <p className="text-muted text-xs">Tax identifiers visible to owners/admins only.</p>
          ) : null}
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="font-medium">Open bills</h2>
        <div className="card overflow-hidden">
          <table className="data-table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Due</th>
                <th>Status</th>
                <th className="text-right">Remaining</th>
              </tr>
            </thead>
            <tbody>
              {openBills.length === 0 ? (
                <tr>
                  <td colSpan={4} className="text-muted">
                    No open bills.
                  </td>
                </tr>
              ) : (
                openBills.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link href={billPath(row.id as string)} className="font-medium">
                        {row.number}
                      </Link>
                    </td>
                    <td>{row.due_date ? formatDate(row.due_date) : "—"}</td>
                    <td>
                      <StatusBadge status={row.status as string} />
                    </td>
                    <td className="text-right font-tabular">{money(row.remaining)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-medium">Vendor credits</h2>
        <div className="card overflow-hidden">
          <table className="data-table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Date</th>
                <th>Status</th>
                <th className="text-right">Available</th>
              </tr>
            </thead>
            <tbody>
              {creditRows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="text-muted">
                    No vendor credits.
                  </td>
                </tr>
              ) : (
                creditRows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link href={vendorCreditPath(row.id as string)} className="font-medium">
                        {row.number}
                      </Link>
                    </td>
                    <td>{formatDate(row.issue_date)}</td>
                    <td>
                      <StatusBadge status={row.status as string} />
                    </td>
                    <td className="text-right font-tabular">{money(row.remaining)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-medium">Purchase orders</h2>
        <div className="card overflow-hidden">
          <table className="data-table">
            <thead>
              <tr>
                <th>PO #</th>
                <th>Date</th>
                <th>Status</th>
                <th className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {(pos ?? []).length === 0 ? (
                <tr>
                  <td colSpan={4} className="text-muted">
                    No purchase orders.
                  </td>
                </tr>
              ) : (
                (pos ?? []).map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link href={purchaseOrderPath(row.id as string)} className="font-medium">
                        {row.number}
                      </Link>
                    </td>
                    <td>{formatDate(row.issue_date)}</td>
                    <td>
                      <StatusBadge status={row.status as string} />
                    </td>
                    <td className="text-right font-tabular">{money(row.total)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-medium">Recent payments</h2>
        <div className="card overflow-hidden">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Reference</th>
                <th className="text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {(payments ?? []).length === 0 ? (
                <tr>
                  <td colSpan={3} className="text-muted">
                    No payments recorded.
                  </td>
                </tr>
              ) : (
                (payments ?? []).map((row) => (
                  <tr key={row.id}>
                    <td>{formatDate(row.payment_date)}</td>
                    <td>{row.reference_number || "—"}</td>
                    <td className="text-right font-tabular">{money(row.amount)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {(audit ?? []).length ? (
        <section className="space-y-3">
          <h2 className="font-medium">Audit history</h2>
          <ul className="card divide-y text-sm">
            {(audit ?? []).map((event, index) => (
              <li key={index} className="px-4 py-2 flex justify-between gap-4">
                <span>{event.action}</span>
                <span className="text-muted">{formatDate(event.created_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
