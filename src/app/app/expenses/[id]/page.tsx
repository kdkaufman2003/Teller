import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDate, money } from "@/lib/format";
import {
  getReceiptSignedUrl,
  guessReceiptMime,
  isBrowserDisplayableImage,
  isPdfMime,
} from "@/lib/expenses/receipt-storage";
import { routes } from "@/lib/routes";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

type ExpenseMetadata = {
  expense_type?: string;
  miles?: number;
  rate_per_mile?: number;
  classification?: {
    accountCode?: string;
    confidence?: string;
    reason?: string;
    source?: string;
  };
};

export default async function ExpenseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSessionContext();
  if (!session?.organization) notFound();
  const { id } = await params;
  const supabase = await createClient();

  const { data: expense } = await supabase
    .from("teller_documents")
    .select("*")
    .eq("organization_id", session.organization.id)
    .eq("kind", "expense")
    .eq("id", id)
    .maybeSingle();

  if (!expense) notFound();

  const meta = (expense.metadata ?? {}) as ExpenseMetadata;
  const typeLabel =
    meta.expense_type === "mileage"
      ? "Mileage"
      : meta.expense_type === "receipt"
        ? "Receipt"
        : "Manual";

  const [{ data: lines }, { data: party }] = await Promise.all([
    supabase
      .from("teller_document_lines")
      .select("id, description, quantity, amount, item_type, account_id")
      .eq("document_id", id)
      .order("sort_order"),
    expense.party_id
      ? supabase.from("teller_parties").select("name").eq("id", expense.party_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const accountIds = [...new Set((lines ?? []).map((line) => line.account_id).filter(Boolean))];
  const { data: accounts } = accountIds.length
    ? await supabase
        .from("teller_accounts")
        .select("id, code, name")
        .eq("organization_id", session.organization.id)
        .in("id", accountIds)
    : { data: [] as { id: string; code: string; name: string }[] };

  const accountNames = new Map(
    (accounts ?? []).map((row) => [row.id, `${row.code} · ${row.name}`]),
  );

  const attachmentPath = expense.attachment_path?.trim() || null;
  const receiptUrl = attachmentPath
    ? await getReceiptSignedUrl(supabase, attachmentPath)
    : null;
  const receiptMime = attachmentPath ? guessReceiptMime(attachmentPath) : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href={routes.expenses} className="text-sm text-muted">
            ← Expenses
          </Link>
          <h1 className="font-ledger mt-2 text-4xl text-navy">{expense.number}</h1>
          <p className="mt-1 text-muted">{party?.name || expense.memo || "No vendor"}</p>
        </div>
        <StatusBadge status={expense.status} />
      </div>

      <div className="grid gap-3 text-sm md:grid-cols-4">
        <div className="card p-4">
          <p className="text-muted">Type</p>
          <p>{typeLabel}</p>
        </div>
        <div className="card p-4">
          <p className="text-muted">Date</p>
          <p>{formatDate(expense.issue_date)}</p>
        </div>
        <div className="card p-4">
          <p className="text-muted">Amount</p>
          <p className="font-tabular">{money(expense.total)}</p>
        </div>
        <div className="card p-4">
          <p className="text-muted">Receipt</p>
          <p>{attachmentPath ? "Attached" : "None"}</p>
        </div>
      </div>

      {meta.expense_type === "mileage" && meta.miles != null ? (
        <p className="text-sm text-muted">
          {meta.miles} mi @ ${Number(meta.rate_per_mile ?? 0.7).toFixed(2)}/mi
        </p>
      ) : null}

      {meta.classification?.accountCode ? (
        <p className="text-sm text-muted">
          Category suggestion: {meta.classification.accountCode}
          {meta.classification.reason ? ` — ${meta.classification.reason}` : ""}
        </p>
      ) : null}

      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Description</th>
              <th>Account</th>
              <th>Type</th>
              <th className="text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {(lines ?? []).map((line) => (
              <tr key={line.id}>
                <td>{line.description}</td>
                <td>{line.account_id ? accountNames.get(line.account_id) || "—" : "—"}</td>
                <td>{line.item_type}</td>
                <td className="text-right font-tabular">{money(line.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="border-t border-rule px-4 py-4 text-right font-tabular">
          <p className="text-lg font-semibold">Total {money(expense.total)}</p>
        </div>
      </div>

      {expense.memo ? <p className="text-sm text-muted">{expense.memo}</p> : null}

      {attachmentPath ? (
        <section className="card p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-medium text-ink">Receipt</h2>
            {receiptUrl ? (
              <a
                href={receiptUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-sky underline-offset-2 hover:underline"
              >
                Open in new tab
              </a>
            ) : (
              <span className="text-sm text-muted">Could not load receipt file</span>
            )}
          </div>

          {receiptUrl && receiptMime && isBrowserDisplayableImage(receiptMime) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={receiptUrl}
              alt={`Receipt for ${expense.number}`}
              className="max-h-[70vh] w-full rounded-lg border border-rule object-contain bg-paper"
            />
          ) : null}

          {receiptUrl && receiptMime && isPdfMime(receiptMime) ? (
            <iframe
              src={receiptUrl}
              title={`Receipt for ${expense.number}`}
              className="h-[70vh] w-full rounded-lg border border-rule bg-paper"
            />
          ) : null}

          {receiptUrl && receiptMime && !isBrowserDisplayableImage(receiptMime) && !isPdfMime(receiptMime) ? (
            <p className="text-sm text-muted">
              Preview not available for this file type. Use “Open in new tab” to download.
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
