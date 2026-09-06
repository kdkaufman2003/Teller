import Link from "next/link";
import { notFound } from "next/navigation";
import { PurchaseOrderActions } from "@/components/PurchaseOrderActions";
import { StatusBadge } from "@/components/StatusBadge";
import { loadPurchaseOrderDetail } from "@/lib/accounting/purchase-orders";
import { asNumber, formatDate, money } from "@/lib/format";
import { billPath, routes } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export default async function PurchaseOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSessionContext();
  if (!session?.organization) notFound();
  const { id } = await params;
  const supabase = await createClient();

  let detail;
  try {
    detail = await loadPurchaseOrderDetail(supabase, session.organization.id, id);
  } catch {
    notFound();
  }

  const { po, lines, receipts, linkedBills } = detail;
  const partyRaw = po.teller_parties as { name?: string } | { name?: string }[] | null;
  const party = Array.isArray(partyRaw) ? partyRaw[0] : partyRaw;

  return (
    <div className="space-y-6">
      <div>
        <Link href={routes.purchaseOrders} className="text-sm text-muted">
          ← Purchase orders
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="font-ledger text-4xl text-navy">{po.number as string}</h1>
          <StatusBadge status={po.status as string} />
        </div>
        <p className="text-muted">{party?.name || "Vendor"}</p>
      </div>

      <div className="card p-4 grid gap-3 md:grid-cols-4 text-sm">
        <div>
          <p className="text-muted">Issue date</p>
          <p>{formatDate(po.issue_date as string)}</p>
        </div>
        <div>
          <p className="text-muted">Expected</p>
          <p>{po.expected_date ? formatDate(po.expected_date as string) : "—"}</p>
        </div>
        <div>
          <p className="text-muted">Total</p>
          <p className="font-tabular">{money(po.total)}</p>
        </div>
        <div>
          <p className="text-muted">Memo</p>
          <p>{(po.memo as string) || "—"}</p>
        </div>
      </div>

      <PurchaseOrderActions
        id={id}
        status={po.status as string}
        lines={(lines ?? []).map((line) => ({
          id: line.id as string,
          description: line.description as string,
          quantity: asNumber(line.quantity),
          quantity_received: asNumber(line.quantity_received),
          quantity_billed: asNumber(line.quantity_billed),
          unit_cost: asNumber(line.unit_cost),
        }))}
      />

      <section className="space-y-3">
        <h2 className="font-medium">Lines</h2>
        <div className="card overflow-hidden">
          <table className="data-table">
            <thead>
              <tr>
                <th>Description</th>
                <th>Ordered</th>
                <th>Received</th>
                <th>Billed</th>
                <th className="text-right">Unit cost</th>
                <th className="text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {(lines ?? []).map((line) => (
                <tr key={line.id as string}>
                  <td>{line.description as string}</td>
                  <td>{asNumber(line.quantity)}</td>
                  <td>{asNumber(line.quantity_received)}</td>
                  <td>{asNumber(line.quantity_billed)}</td>
                  <td className="text-right font-tabular">{money(line.unit_cost)}</td>
                  <td className="text-right font-tabular">{money(line.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {(receipts ?? []).length ? (
        <section className="space-y-3">
          <h2 className="font-medium">Receiving history</h2>
          <ul className="card divide-y text-sm">
            {(receipts ?? []).map((receipt) => (
              <li key={receipt.id as string} className="px-4 py-3">
                <p className="font-medium">{formatDate(receipt.receipt_date as string)}</p>
                <p className="text-muted">
                  Ref: {(receipt.reference_number as string) || "—"} · Location:{" "}
                  {(receipt.location as string) || "—"}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {(linkedBills ?? []).length ? (
        <section className="space-y-3">
          <h2 className="font-medium">Linked bills</h2>
          <ul className="card divide-y text-sm">
            {(linkedBills ?? []).map((bill) => (
              <li key={bill.id as string} className="px-4 py-3 flex justify-between">
                <Link href={billPath(bill.id as string)} className="font-medium">
                  {bill.number as string}
                </Link>
                <span>
                  <StatusBadge status={bill.status as string} /> · {money(bill.total)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
