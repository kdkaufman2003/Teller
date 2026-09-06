import Link from "next/link";
import { notFound } from "next/navigation";
import { CreditMemoForm } from "@/components/CreditMemoForm";
import { InvoiceActions } from "@/components/InvoiceActions";
import { StatusBadge } from "@/components/StatusBadge";
import {
  authoritativeDocumentRemaining,
  authoritativeDocumentSettled,
} from "@/lib/accounting/balances";
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

  const [{ data: lines }, { data: party }, { data: job }] = await Promise.all([
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
  ]);

  const paymentMeta = (invoice.metadata as { payment?: {
    gross?: number;
    net?: number;
    fee?: number;
    processor?: string | null;
  } } | null)?.payment;

  const organizationId = session.organization.id;
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
      <InvoiceActions
        id={invoice.id}
        status={invoice.status}
        total={asNumber(invoice.total)}
        amountPaid={settled.payments}
        remaining={remaining}
      />
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
