import Link from "next/link";
import { CompanyContextHeader } from "@/components/legal-entity/CompanyContextHeader";
import { resolveLegalEntityId } from "@/lib/accounting/post";
import { loadVendorBalanceDetails } from "@/lib/accounting/party-balance-detail";
import { money } from "@/lib/format";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { billPath, routes, vendorCreditPath, vendorPath } from "@/lib/routes";
import { redirect } from "next/navigation";

type PageProps = {
  searchParams: Promise<{ asOf?: string }>;
};

function documentHref(kind: string, id: string): string {
  if (kind === "vendor_credit") return vendorCreditPath(id);
  return billPath(id);
}

export default async function VendorBalancesPage({ searchParams }: PageProps) {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  const params = await searchParams;
  const asOf = params.asOf?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  const supabase = await createClient();
  const organizationId = session.organization.id;
  const legalEntityId = await resolveLegalEntityId(
    supabase,
    organizationId,
    session.profile?.active_legal_entity_id ?? null,
  );

  const rows = await loadVendorBalanceDetails(supabase, organizationId, asOf, legalEntityId);
  const totals = rows.reduce(
    (acc, row) => ({
      documentBalance: acc.documentBalance + row.documentBalance,
      unappliedCredits: acc.unappliedCredits + row.unappliedCredits,
      netBalance: acc.netBalance + row.netBalance,
    }),
    { documentBalance: 0, unappliedCredits: 0, netBalance: 0 },
  );

  return (
    <div className="space-y-6">
      <CompanyContextHeader activeLegalEntity={session.activeLegalEntity} />
      <header className="page-header">
        <Link href={routes.reports} className="text-sm text-muted">
          ← Reports
        </Link>
        <h1 className="mt-2">Vendor balances</h1>
        <p className="text-muted">
          Open AP subledger as of {asOf} · canonical party balances with document drilldown
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="card p-4">
          <p className="text-sm text-muted">Open bills</p>
          <p className="font-ledger mt-1 text-xl">{money(totals.documentBalance)}</p>
        </div>
        <div className="card p-4">
          <p className="text-sm text-muted">Unapplied vendor credits</p>
          <p className="font-ledger mt-1 text-xl">{money(totals.unappliedCredits)}</p>
        </div>
        <div className="card p-4">
          <p className="text-sm text-muted">Net AP</p>
          <p className="font-ledger mt-1 text-xl">{money(totals.netBalance)}</p>
        </div>
      </div>

      {rows.map((row) => (
        <article key={row.partyId} className="card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
            <div>
              <Link href={vendorPath(row.partyId)} className="font-medium text-sky underline">
                {row.partyName}
              </Link>
              <p className="text-sm text-muted">
                Net {money(row.netBalance)} · Open docs {money(row.documentBalance)} · Credits{" "}
                {money(row.unappliedCredits)}
              </p>
            </div>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Kind</th>
                <th>Issue</th>
                <th>Due</th>
                <th>Aging</th>
                <th className="text-right">Remaining</th>
              </tr>
            </thead>
            <tbody>
              {[...row.openDocuments, ...row.creditDocuments].map((doc) => (
                <tr key={doc.documentId}>
                  <td>
                    <Link href={documentHref(doc.kind, doc.documentId)} className="underline">
                      {doc.number}
                    </Link>
                  </td>
                  <td className="capitalize">{doc.kind.replace(/_/g, " ")}</td>
                  <td>{doc.issueDate}</td>
                  <td>{doc.dueDate ?? "—"}</td>
                  <td className="capitalize">{doc.agingBucket.replace(/_/g, " ")}</td>
                  <td className="text-right font-tabular">{money(doc.remaining)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>
      ))}

      {!rows.length ? (
        <p className="text-sm text-muted">No open vendor balances as of {asOf}.</p>
      ) : null}
    </div>
  );
}
