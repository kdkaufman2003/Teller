import { formatDate, money } from "@/lib/format";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { asNumber } from "@/lib/format";
import { routes } from "@/lib/routes";
import { redirect } from "next/navigation";

export default async function LedgerPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  const supabase = await createClient();
  const organizationId = session.organization.id;

  const { data: entries } = await supabase
    .from("teller_journal_entries")
    .select("id, entry_date, memo, source_kind")
    .eq("organization_id", organizationId)
    .order("entry_date", { ascending: false })
    .limit(40);

  const ids = (entries ?? []).map((row) => row.id);
  const [{ data: lines }, { data: accounts }] = await Promise.all([
    ids.length
      ? supabase
          .from("teller_journal_lines")
          .select("entry_id, account_id, debit, credit, memo")
          .in("entry_id", ids)
      : Promise.resolve({ data: [] }),
    supabase
      .from("teller_accounts")
      .select("id, code, name")
      .eq("organization_id", organizationId),
  ]);

  const accountMap = new Map(
    (accounts ?? []).map((row) => [row.id, `${row.code} ${row.name}`]),
  );

  return (
    <div className="space-y-6">
      <header className="page-header">
        <h1>Ledger</h1>
      </header>
      {(entries ?? []).length === 0 ? (
        <p className="text-muted">No journal entries yet. Post an invoice or expense.</p>
      ) : (
        (entries ?? []).map((entry) => {
          const entryLines = (lines ?? []).filter((line) => line.entry_id === entry.id);
          const debit = entryLines.reduce((sum, line) => sum + asNumber(line.debit), 0);
          return (
            <article key={entry.id} className="card p-4">
              <div className="flex justify-between gap-3 text-sm">
                <div>
                  <p className="font-medium">{entry.memo || "Journal entry"}</p>
                  <p className="text-muted">
                    {formatDate(entry.entry_date)}
                    {entry.source_kind ? ` · ${entry.source_kind}` : ""}
                  </p>
                </div>
                <p className="font-tabular">{money(debit)}</p>
              </div>
              <ul className="mt-3 space-y-1 font-tabular text-sm">
                {entryLines.map((line, index) => (
                  <li key={`${entry.id}-${index}`} className="flex justify-between gap-4">
                    <span>{accountMap.get(line.account_id)}</span>
                    <span className="text-muted">
                      {asNumber(line.debit) > 0
                        ? `Dr ${money(line.debit)}`
                        : `Cr ${money(line.credit)}`}
                    </span>
                  </li>
                ))}
              </ul>
            </article>
          );
        })
      )}
    </div>
  );
}
