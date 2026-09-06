import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusBadge } from "@/components/StatusBadge";
import { DepositSettlementActions } from "@/components/InvoiceSettlementActions";
import { authoritativeDocumentRemaining } from "@/lib/accounting/balances";
import { batchDepositRemainingForPayments } from "@/lib/accounting/deposits";
import { computeCustomerNetPosition } from "@/lib/accounting/deposit-reconciliation";
import { authoritativeCustomerArBalance } from "@/lib/accounting/party-balances";
import { asNumber, formatDate, money } from "@/lib/format";
import { routes } from "@/lib/routes";
import { getSessionContext, label } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSessionContext();
  if (!session?.organization) notFound();
  const { id } = await params;
  const supabase = await createClient();
  const organizationId = session.organization.id;

  const { data: party } = await supabase
    .from("teller_parties")
    .select("id, name, email")
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();

  if (!party) notFound();

  const [{ data: invoices }, { data: deposits }] = await Promise.all([
    supabase
      .from("teller_documents")
      .select("id, number, total, status, issue_date")
      .eq("organization_id", organizationId)
      .eq("kind", "invoice")
      .eq("party_id", id)
      .in("status", ["open", "partially_paid", "paid"])
      .order("issue_date", { ascending: false }),
    supabase
      .from("teller_payments")
      .select("id, amount, payment_date, reference_number, status")
      .eq("organization_id", organizationId)
      .eq("party_id", id)
      .eq("payment_type", "customer_deposit")
      .eq("status", "posted")
      .order("payment_date", { ascending: false }),
  ]);

  const depositRows = deposits ?? [];
  const remainingMap = await batchDepositRemainingForPayments(
    supabase,
    organizationId,
    depositRows.map((row) => ({ id: row.id as string, amount: asNumber(row.amount) })),
  );

  const openInvoices = await Promise.all(
    (invoices ?? []).map(async (row) => ({
      ...row,
      remaining: await authoritativeDocumentRemaining(
        supabase,
        organizationId,
        row.id as string,
        asNumber(row.total),
      ),
    })),
  );

  const customerAr = await authoritativeCustomerArBalance(supabase, organizationId, id);
  const netPosition = await computeCustomerNetPosition(
    supabase,
    organizationId,
    id,
    customerAr.netAr,
  );

  return (
    <div className="space-y-6">
      <div>
        <Link href={routes.customers} className="text-sm text-muted">
          ← {label(session.settings, "customer", "Customers")}
        </Link>
        <h1 className="font-ledger mt-2 text-4xl text-navy">{party.name}</h1>
        {party.email ? <p className="text-muted">{party.email}</p> : null}
      </div>

      <div className="card p-4 grid gap-4 md:grid-cols-2 lg:grid-cols-4 text-sm">
        <div>
          <p className="text-muted">Open invoice balance</p>
          <p className="font-tabular text-lg">
            {money(openInvoices.reduce((sum, row) => sum + row.remaining, 0))}
          </p>
        </div>
        <div>
          <p className="text-muted">Unapplied deposits</p>
          <p className="font-tabular text-lg">{money(netPosition.unappliedDeposits)}</p>
        </div>
        <div>
          <p className="text-muted">Net AR (after credits)</p>
          <p className="font-tabular text-lg">{money(netPosition.netAr)}</p>
        </div>
        <div>
          <p className="text-muted">Amount due after deposits</p>
          <p className="font-tabular text-lg font-semibold">{money(netPosition.netDue)}</p>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="border-b border-rule px-4 py-3 font-medium">Invoices</div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Number</th>
              <th>Date</th>
              <th>Status</th>
              <th className="text-right">Total</th>
              <th className="text-right">Remaining</th>
            </tr>
          </thead>
          <tbody>
            {openInvoices.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-muted">
                  No open invoices
                </td>
              </tr>
            ) : (
              openInvoices.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link href={`${routes.invoices}/${row.id}`} className="font-medium">
                      {row.number}
                    </Link>
                  </td>
                  <td>{formatDate(row.issue_date)}</td>
                  <td>
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="text-right font-tabular">{money(row.total)}</td>
                  <td className="text-right font-tabular">{money(row.remaining)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="card overflow-hidden">
        <div className="border-b border-rule px-4 py-3 font-medium">Deposits</div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Reference</th>
              <th className="text-right">Received</th>
              <th className="text-right">Applied</th>
              <th className="text-right">Remaining</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {depositRows.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-muted">
                  No deposits recorded
                </td>
              </tr>
            ) : (
              depositRows.map((row) => {
                const amount = asNumber(row.amount);
                const remaining = remainingMap.get(row.id as string) ?? amount;
                return (
                  <tr key={row.id}>
                    <td>{formatDate(row.payment_date)}</td>
                    <td>{row.reference_number || "—"}</td>
                    <td className="text-right font-tabular">{money(amount)}</td>
                    <td className="text-right font-tabular">{money(amount - remaining)}</td>
                    <td className="text-right font-tabular">{money(remaining)}</td>
                    <td className="text-right">
                      <DepositSettlementActions depositId={row.id as string} remaining={remaining} />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
