import Link from "next/link";
import { resolveJournalSource } from "@/lib/accounting/source-resolver";
import { money } from "@/lib/format";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { ledgerEntryPath, routes } from "@/lib/routes";
import { redirect, notFound } from "next/navigation";

type PageProps = { params: Promise<{ entryId: string }> };

export default async function LedgerEntryPage({ params }: PageProps) {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);

  const { entryId } = await params;
  const supabase = await createClient();
  const organizationId = session.organization.id;

  const { data: entry } = await supabase
    .from("teller_journal_entries")
    .select("id, entry_date, memo, source_kind, source_id, reverses_entry_id, organization_id")
    .eq("id", entryId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!entry) notFound();

  const [{ data: lines }, { data: accounts }] = await Promise.all([
    supabase
      .from("teller_journal_lines")
      .select("id, account_id, debit, credit, memo")
      .eq("entry_id", entryId)
      .order("id"),
    supabase
      .from("teller_accounts")
      .select("id, code, name, type")
      .eq("organization_id", organizationId),
  ]);

  const accountMap = new Map(
    (accounts ?? []).map((row) => [
      row.id as string,
      { code: row.code as string, name: row.name as string, type: row.type as string },
    ]),
  );

  const source = resolveJournalSource({
    sourceKind: entry.source_kind as string | null,
    sourceId: entry.source_id as string | null,
    memo: entry.memo as string | null,
    reversesEntryId: entry.reverses_entry_id as string | null,
  });

  return (
    <div className="space-y-6">
      <header className="page-header">
        <Link href={routes.ledger} className="text-sm text-muted">
          ← Ledger
        </Link>
        <h1 className="mt-2">Journal entry</h1>
        <p className="text-muted">
          {entry.entry_date as string} · {source.label}
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="card p-4">
          <p className="text-sm text-muted">Memo</p>
          <p className="mt-1">{(entry.memo as string | null) || "—"}</p>
        </div>
        <div className="card p-4">
          <p className="text-sm text-muted">Source transaction</p>
          {source.href ? (
            <Link href={source.href} className="mt-1 inline-block text-sky underline">
              {source.label}
            </Link>
          ) : (
            <p className="mt-1">{source.label}</p>
          )}
          {entry.reverses_entry_id ? (
            <p className="mt-2 text-sm text-muted">
              Reverses{" "}
              <Link
                href={ledgerEntryPath(entry.reverses_entry_id as string)}
                className="text-sky underline"
              >
                original entry
              </Link>
            </p>
          ) : null}
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="data-table">
          <thead>
            <tr>
              <th>Account</th>
              <th>Memo</th>
              <th className="text-right">Debit</th>
              <th className="text-right">Credit</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(lines ?? []).map((line) => {
              const account = accountMap.get(line.account_id as string);
              return (
                <tr key={line.id as string}>
                  <td>
                    <span className="font-tabular text-muted">{account?.code ?? "—"}</span>{" "}
                    {account?.name ?? "Unknown"}
                  </td>
                  <td className="text-muted">{(line.memo as string | null) || "—"}</td>
                  <td className="text-right font-tabular">{money(line.debit)}</td>
                  <td className="text-right font-tabular">{money(line.credit)}</td>
                  <td className="text-right">
                    {account ? (
                      <Link
                        href={`${routes.reports}/account/${line.account_id as string}`}
                        className="text-sm text-sky hover:underline"
                      >
                        Activity
                      </Link>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
