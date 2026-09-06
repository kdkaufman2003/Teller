import Link from "next/link";
import { VendorCreditCreatePanel } from "@/components/VendorCreditCreatePanel";
import { StatusBadge } from "@/components/StatusBadge";
import { sumCreditsAppliedFromDocument } from "@/lib/accounting/document-allocations";
import { asNumber, formatDate, money } from "@/lib/format";
import { routes, vendorCreditPath } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function VendorCreditsPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  const supabase = await createClient();
  const organizationId = session.organization.id;

  const [{ data: credits }, { data: vendors }, { data: accounts }] = await Promise.all([
      supabase
        .from("teller_documents")
        .select("id, number, status, total, issue_date, party_id, memo")
        .eq("organization_id", organizationId)
        .eq("kind", "vendor_credit")
        .order("issue_date", { ascending: false }),
      supabase
        .from("teller_parties")
        .select("id, name")
        .eq("organization_id", organizationId)
        .in("kind", ["vendor", "both"])
        .order("name"),
      supabase
        .from("teller_accounts")
        .select("id, code, name, type")
        .eq("organization_id", organizationId)
      .in("type", ["expense", "cogs"])
      .order("code"),
  ]);

  const partyNames = new Map((vendors ?? []).map((row) => [row.id, row.name]));

  const rows = await Promise.all(
    (credits ?? []).map(async (row) => {
      const applied = await sumCreditsAppliedFromDocument(
        supabase,
        organizationId,
        row.id as string,
      );
      return {
        ...row,
        party_name: row.party_id ? partyNames.get(row.party_id) || "" : "",
        unapplied: asNumber(row.total) - applied,
      };
    }),
  );

  return (
    <div className="space-y-6">
      <header className="page-header">
        <h1>Vendor credits</h1>
        <p>Credits reduce AP when applied — no additional GL on application.</p>
      </header>
      <VendorCreditCreatePanel vendors={vendors ?? []} accounts={accounts ?? []} />
      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Number</th>
              <th>Vendor</th>
              <th>Date</th>
              <th>Status</th>
              <th className="text-right">Total</th>
              <th className="text-right">Available</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-muted">
                  No vendor credits yet.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link href={vendorCreditPath(row.id as string)} className="font-medium">
                      {row.number}
                    </Link>
                  </td>
                  <td>{row.party_name || "—"}</td>
                  <td>{formatDate(row.issue_date)}</td>
                  <td>
                    <StatusBadge status={row.status as string} />
                  </td>
                  <td className="text-right font-tabular">{money(row.total)}</td>
                  <td className="text-right font-tabular">{money(row.unapplied)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
