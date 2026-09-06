import Link from "next/link";
import { notFound } from "next/navigation";
import { CreditMemoForm } from "@/components/CreditMemoForm";
import { ApplyDepositForm } from "@/components/ApplyDepositForm";
import { DocumentPaymentHistory } from "@/components/DocumentPaymentHistory";
import { InvoiceActions } from "@/components/InvoiceActions";
import { StatusBadge } from "@/components/StatusBadge";
import {
  authoritativeDocumentRemaining,
  authoritativeDocumentSettled,
} from "@/lib/accounting/balances";
import { batchDepositRemainingForPayments } from "@/lib/accounting/deposits";
import { computeCustomerNetPosition } from "@/lib/accounting/deposit-reconciliation";
import { authoritativeCustomerArBalance } from "@/lib/accounting/party-balances";
import { asNumber, formatDate, money } from "@/lib/format";
import { routes } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSessionContext();
  if (!session?.organization) notFound();
  const { id } = await params;
  const supabase = await createClient();

  const { data: invoice } = await supabase
    .from("teller_documents")
    .select("*")
    .eq("organization_id", session.organization.id)
    .eq("id", id)
    .maybeSingle();
  if (!invoice) notFound();

  const organizationId = session.organization.id;

  const [{ data: lines }, { data: party }, { data: job }, { data: paymentAllocations }] =
    await Promise.all([
    supabase
      .from("teller_document_lines")
      .select("*")
      .eq("document_id", id)
      .order("sort_order"),
    invoice.party_id
      ? supabase.from("teller_parties").select("name").eq("id", invoice.party_id).maybeSingle()
      : Promise.resolve({ data: null }),
    invoice.job_id
      ? supabase
          .from("teller_jobs")
          .select("job_number, name")
          .eq("id", invoice.job_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("teller_payment_allocations")
      .select(
        "amount, allocation_kind, reversed_by_allocation_id, payment:teller_payments(id, amount, payment_date, payment_method, reference_number, status, payment_type)",
      )
      .eq("organization_id", organizationId)
      .eq("document_id", id)
      .in("allocation_kind", ["invoice_payment", "deposit_apply"]),
  ]);

  const paymentMeta = (invoice.metadata as { payment?: {
    gross?: number;
    net?: number;
    fee?: number;
    processor?: string | null;
  } } | null)?.payment;

  const settled = await authoritativeDocumentSettled(supabase, organizationId, id);
  const remaining = await authoritativeDocumentRemaining(
    supabase,
    organizationId,
    id,
    asNumber(invoice.total),
  );

  const { data: revenueAccounts } = await supabase
    .from("teller_accounts")
    .select("id, code, name")
    .eq("organization_id", organizationId)
    .eq("type", "revenue")
    .order("code");

  let depositOptions: {
    id: string;
    remaining: number;
    payment_date: string;
    reference_number?: string | null;
  }[] = [];
  let netDue: number | null = null;

  if (invoice.party_id) {
    const { data: depositPayments } = await supabase
      .from("teller_payments")
      .select("id, amount, payment_date, reference_number")
      .eq("organization_id", organizationId)
      .eq("party_id", invoice.party_id)
      .eq("payment_type", "customer_deposit")
      .eq("status", "posted");

    const rows = depositPayments ?? [];
    const remainingMap = await batchDepositRemainingForPayments(
      supabase,
      organizationId,
      rows.map((row) => ({ id: row.id as string, amount: asNumber(row.amount) })),
    );
    depositOptions = rows.map((row) => ({
      id: row.id as string,
      payment_date: row.payment_date as string,
      reference_number: row.reference_number,
      remaining: remainingMap.get(row.id as string) ?? asNumber(row.amount),
    }));

    const customerAr = await authoritativeCustomerArBalance(
      supabase,
      organizationId,
      invoice.party_id,
    );
    const netPosition = await computeCustomerNetPosition(
      supabase,
      organizationId,
      invoice.party_id,
      customerAr.netAr,
    );
    netDue = netPosition.netDue;
  }

  const paymentHistory = (paymentAllocations ?? [])
    .filter((row) => !row.reversed_by_allocation_id)
    .map((row) => {
      const paymentRaw = row.payment as
        | {
            id: string;
            amount: number;
            payment_date: string;
            payment_method?: string | null;
            reference_number?: string | null;
            status: string;
            payment_type: string;
          }
        | {
            id: string;
            amount: number;
            payment_date: string;
            payment_method?: string | null;
            reference_number?: string | null;
            status: string;
            payment_type: string;
          }[]
        | null;
      const payment = Array.isArray(paymentRaw) ? paymentRaw[0] : paymentRaw;
      if (!payment) return null;
      return {
        paymentId: payment.id,
        amount: asNumber(row.amount),
        paymentDate: formatDate(payment.payment_date),
        method: payment.payment_method,
        reference: payment.reference_number,
        status: payment.status,
        canReverse:
          row.allocation_kind === "invoice_payment" &&
          payment.payment_type === "customer_payment" &&
          payment.status === "posted",
      };
    })
    .filter((row): row is NonNullable<typeof row> => row != null);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href={routes.invoices} className="text-sm text-muted">
            ← Invoices
          </Link>
          <h1 className="font-ledger mt-2 text-4xl text-navy">{invoice.number}</h1>
          <p className="mt-1 text-muted">{party?.name || "No customer"}</p>
        </div>
        <StatusBadge status={invoice.status} />
      </div>

      <div className="grid gap-3 text-sm md:grid-cols-3">
        <div className="card p-4">
          <p className="text-muted">Issue date</p>
          <p>{formatDate(invoice.issue_date)}</p>
        </div>
        <div className="card p-4">
          <p className="text-muted">Due</p>
          <p>{formatDate(invoice.due_date)}</p>
        </div>
        <div className="card p-4">
          <p className="text-muted">Job</p>
          <p>{job ? `${job.job_number} · ${job.name}` : "—"}</p>
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Description</th>
              <th>Type</th>
              <th className="text-right">Qty</th>
              <th className="text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {(lines ?? []).map((line) => (
              <tr key={line.id}>
                <td>{line.description}</td>
                <td>{line.item_type}</td>
                <td className="text-right font-tabular">{line.quantity}</td>
                <td className="text-right font-tabular">{money(line.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="space-y-1 border-t border-rule px-4 py-4 text-right font-tabular">
          <p>Subtotal {money(invoice.subtotal)}</p>
          <p>Tax {money(invoice.tax)}</p>
          <p className="text-lg font-semibold">Total {money(invoice.total)}</p>
        </div>
      </div>

      {paymentMeta?.fee != null && paymentMeta.fee > 0 ? (
        <div className="card p-4 text-sm space-y-1">
          <p className="font-medium text-ink">Payment settlement</p>
          <p>
            Collected {money(paymentMeta.gross ?? invoice.total)}
            {paymentMeta.processor ? ` via ${paymentMeta.processor}` : ""}
          </p>
          <p className="text-muted">
            Processing fee {money(paymentMeta.fee)} · Deposited {money(paymentMeta.net ?? 0)}
          </p>
        </div>
      ) : null}

      {invoice.memo ? <p className="text-sm text-muted">{invoice.memo}</p> : null}
      {netDue != null && invoice.party_id ? (
        <p className="text-sm text-muted">
          Customer net due after unapplied deposits: ${netDue.toFixed(2)}
        </p>
      ) : null}
      <InvoiceActions
        id={invoice.id}
        status={invoice.status}
        total={asNumber(invoice.total)}
        amountPaid={settled.payments}
        remaining={remaining}
      />
      <DocumentPaymentHistory payments={paymentHistory} />
      {invoice.party_id && invoice.status !== "draft" && invoice.status !== "void" ? (
        <ApplyDepositForm
          invoiceId={invoice.id}
          partyId={invoice.party_id}
          invoiceRemaining={remaining}
          deposits={depositOptions}
        />
      ) : null}
      {invoice.party_id && invoice.status !== "draft" && invoice.status !== "void" ? (
        <CreditMemoForm
          invoiceId={invoice.id}
          partyId={invoice.party_id}
          invoiceTotal={asNumber(invoice.total)}
          remaining={remaining}
          revenueAccounts={revenueAccounts ?? []}
        />
      ) : null}
    </div>
  );
}
