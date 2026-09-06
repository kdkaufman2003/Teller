import Link from "next/link";
import { notFound } from "next/navigation";
import { VendorCreditForm } from "@/components/VendorCreditForm";
import { BillActions } from "@/components/BillActions";
import { StatusBadge } from "@/components/StatusBadge";
import { authoritativeDocumentSettled, authoritativeDocumentRemaining } from "@/lib/accounting/balances";
import { asNumber, formatDate, money } from "@/lib/format";
import { routes } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export default async function BillDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSessionContext();
  if (!session?.organization) notFound();
  const { id } = await params;
  const supabase = await createClient();
  const organizationId = session.organization.id;

  const { data: bill } = await supabase
    .from("teller_documents")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("kind", "bill")
    .eq("id", id)
    .maybeSingle();

  if (!bill) notFound();

  const settled = await authoritativeDocumentSettled(supabase, organizationId, id);
  const remaining = await authoritativeDocumentRemaining(
    supabase,
    organizationId,
    id,
    asNumber(bill.total),
  );

  const [{ data: lines }, { data: party }, { data: job }, { data: payments }, { data: creditAllocs }] =
    await Promise.all([
      supabase
        .from("teller_document_lines")
        .select("id, description, quantity, amount, account_id")
        .eq("document_id", id)
        .order("sort_order"),
      bill.party_id
        ? supabase.from("teller_parties").select("name").eq("id", bill.party_id).maybeSingle()
        : Promise.resolve({ data: null }),
      bill.job_id
        ? supabase.from("teller_jobs").select("job_number, name").eq("id", bill.job_id).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .from("teller_payments")
        .select("id, amount, payment_date, payment_method, reference_number")
        .eq("organization_id", organizationId)
        .eq("document_id", id)
        .order("payment_date", { ascending: false }),
      supabase
        .from("teller_document_allocations")
        .select("id, amount, source_document_id, created_at")
        .eq("organization_id", organizationId)
        .eq("target_document_id", id),
    ]);

  const accountIds = [...new Set((lines ?? []).map((line) => line.account_id).filter(Boolean))];
  const { data: accounts } = accountIds.length
    ? await supabase
        .from("teller_accounts")
        .select("id, code, name")
        .eq("organization_id", organizationId)
        .in("id", accountIds)
    : { data: [] as { id: string; code: string; name: string }[] };

  const accountNames = new Map(
    (accounts ?? []).map((row) => [row.id, `${row.code} · ${row.name}`]),
  );

  const { data: expenseAccounts } = await supabase
    .from("teller_accounts")
    .select("id, code, name")
    .eq("organization_id", organizationId)
    .in("type", ["expense", "cogs", "asset"])
    .order("code");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href={routes.bills} className="text-sm text-muted">
            ← Bills
          </Link>
          <h1 className="font-ledger mt-2 text-4xl text-navy">{bill.number}</h1>
          <p className="mt-1 text-muted">
            {party?.name || "No vendor"}
            {bill.reference_number ? ` · Ref ${bill.reference_number}` : ""}
          </p>
        </div>
        <StatusBadge status={bill.status} />
      </div>

      <div className="card p-4 grid gap-4 md:grid-cols-4 text-sm">
        <div>
          <p className="text-muted">Bill date</p>
          <p>{formatDate(bill.issue_date)}</p>
        </div>
        <div>
          <p className="text-muted">Due date</p>
          <p>{bill.due_date ? formatDate(bill.due_date) : "—"}</p>
        </div>
        <div>
          <p className="text-muted">Total</p>
          <p className="font-tabular">{money(bill.total)}</p>
        </div>
        <div>
          <p className="text-muted">Job</p>
          <p>{job ? `${job.job_number} · ${job.name}` : "—"}</p>
        </div>
      </div>

      {bill.memo ? (
        <div className="card p-4 text-sm">
          <p className="text-muted">Memo</p>
          <p>{bill.memo}</p>
        </div>
      ) : null}

      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Description</th>
              <th>Account</th>
              <th className="text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {(lines ?? []).map((line) => (
              <tr key={line.id}>
                <td>{line.description}</td>
                <td className="text-muted">
                  {line.account_id ? accountNames.get(line.account_id) : "—"}
                </td>
                <td className="text-right font-tabular">{money(line.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <BillActions
        id={id}
        status={bill.status}
        total={asNumber(bill.total)}
        amountPaid={settled.payments}
        creditsApplied={settled.credits}
        remaining={remaining}
      />

      {bill.party_id && bill.status !== "draft" && bill.status !== "void" ? (
        <VendorCreditForm
          billId={id}
          partyId={bill.party_id}
          billTotal={asNumber(bill.total)}
          remaining={remaining}
          expenseAccounts={expenseAccounts ?? []}
        />
      ) : null}

      {(payments ?? []).length ? (
        <div className="card overflow-hidden">
          <div className="border-b border-rule px-4 py-3 text-sm font-medium">Payment history</div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Method</th>
                <th>Reference</th>
                <th className="text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {(payments ?? []).map((payment) => (
                <tr key={payment.id}>
                  <td>{formatDate(payment.payment_date)}</td>
                  <td>{payment.payment_method || "—"}</td>
                  <td>{payment.reference_number || "—"}</td>
                  <td className="text-right font-tabular">{money(payment.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {(creditAllocs ?? []).length ? (
        <div className="card overflow-hidden">
          <div className="border-b border-rule px-4 py-3 text-sm font-medium">Vendor credits applied</div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th className="text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {(creditAllocs ?? []).map((row) => (
                <tr key={row.id}>
                  <td>{formatDate(row.created_at.slice(0, 10))}</td>
                  <td className="text-right font-tabular">{money(row.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
