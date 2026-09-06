import Link from "next/link";
import { notFound } from "next/navigation";
import { VendorCreditDetailActions } from "@/components/VendorCreditDetailActions";
import { StatusBadge } from "@/components/StatusBadge";
import { sumCreditsAppliedFromDocument } from "@/lib/accounting/document-allocations";
import { asNumber, formatDate, money } from "@/lib/format";
import { billPath, routes } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export default async function VendorCreditDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSessionContext();
  if (!session?.organization) notFound();
  const { id } = await params;
  const supabase = await createClient();
  const organizationId = session.organization.id;

  const { data: vendorCredit } = await supabase
    .from("teller_documents")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("kind", "vendor_credit")
    .eq("id", id)
    .maybeSingle();
  if (!vendorCredit) notFound();

  const applied = await sumCreditsAppliedFromDocument(supabase, organizationId, id);
  const unapplied = asNumber(vendorCredit.total) - applied;

  const [{ data: lines }, { data: allocations }, { data: party }, { data: openBills }] =
    await Promise.all([
      supabase.from("teller_document_lines").select("*").eq("document_id", id).order("sort_order"),
      supabase
        .from("teller_document_allocations")
        .select("id, amount, target_document_id, created_at")
        .eq("organization_id", organizationId)
        .eq("source_document_id", id),
      vendorCredit.party_id
        ? supabase.from("teller_parties").select("name").eq("id", vendorCredit.party_id).maybeSingle()
        : Promise.resolve({ data: null }),
      vendorCredit.party_id
        ? supabase
            .from("teller_documents")
            .select("id, number")
            .eq("organization_id", organizationId)
            .eq("party_id", vendorCredit.party_id)
            .eq("kind", "bill")
            .in("status", ["open", "partially_paid"])
        : Promise.resolve({ data: [] }),
    ]);

  return (
    <div className="space-y-6">
      <div>
        <Link href={routes.vendorCredits} className="text-sm text-muted">
          ← Vendor credits
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="font-ledger text-4xl text-navy">{vendorCredit.number}</h1>
          <StatusBadge status={vendorCredit.status as string} />
        </div>
        <p className="text-muted">{party?.name || "Vendor"}</p>
      </div>

      <div className="card p-4 grid gap-3 md:grid-cols-4 text-sm">
        <div>
          <p className="text-muted">Issue date</p>
          <p>{formatDate(vendorCredit.issue_date)}</p>
        </div>
        <div>
          <p className="text-muted">Total</p>
          <p className="font-tabular">{money(vendorCredit.total)}</p>
        </div>
        <div>
          <p className="text-muted">Applied</p>
          <p className="font-tabular">{money(applied)}</p>
        </div>
        <div>
          <p className="text-muted">Available</p>
          <p className="font-tabular">{money(unapplied)}</p>
        </div>
      </div>

      <VendorCreditDetailActions
        id={id}
        status={vendorCredit.status as string}
        unapplied={unapplied}
        openBills={(openBills ?? []).map((row) => ({
          id: row.id as string,
          number: row.number as string,
        }))}
        allocations={(allocations ?? []).map((row) => ({
          id: row.id as string,
          amount: asNumber(row.amount),
          target_document_id: row.target_document_id as string,
        }))}
      />

      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Description</th>
              <th className="text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {(lines ?? []).map((line) => (
              <tr key={line.id as string}>
                <td>{line.description as string}</td>
                <td className="text-right font-tabular">{money(line.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(allocations ?? []).length ? (
        <section className="space-y-3">
          <h2 className="font-medium">Applications</h2>
          <ul className="card divide-y text-sm">
            {(allocations ?? []).map((row) => (
              <li key={row.id as string} className="px-4 py-2 flex justify-between">
                <Link href={billPath(row.target_document_id as string)} className="font-medium">
                  Bill
                </Link>
                <span className="font-tabular">{money(row.amount)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
