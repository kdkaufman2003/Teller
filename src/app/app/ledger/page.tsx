import { CompanyContextHeader } from "@/components/legal-entity/CompanyContextHeader";
import { resolveLegalEntityId } from "@/lib/accounting/post";
import { getSessionContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { routes } from "@/lib/routes";
import { redirect } from "next/navigation";
import { LedgerBook, type LedgerEntryRow } from "@/components/LedgerBook";

export default async function LedgerPage() {
  const session = await getSessionContext();
  if (!session?.organization) redirect(routes.setup);
  const supabase = await createClient();
  const organizationId = session.organization.id;
  const legalEntityId = await resolveLegalEntityId(
    supabase,
    organizationId,
    session.profile?.active_legal_entity_id ?? null,
  );

  const { data: entries } = await supabase
    .from("teller_journal_entries")
    .select("id, entry_date, memo, source_kind")
    .eq("organization_id", organizationId)
    .eq("legal_entity_id", legalEntityId)
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
      .eq("organization_id", organizationId)
      .eq("legal_entity_id", legalEntityId),
  ]);

  const accountMap = new Map(
    (accounts ?? []).map((row) => [row.id, { code: row.code, name: row.name }]),
  );

  const totalEntries = (entries ?? []).length;
  const ledgerEntries: LedgerEntryRow[] = (entries ?? []).map((entry, index) => {
    const entryLines = (lines ?? []).filter((line) => line.entry_id === entry.id);
    const folio = String(totalEntries - index).padStart(3, "0");

    return {
      id: entry.id,
      entry_date: entry.entry_date,
      memo: entry.memo || "Journal entry",
      source_kind: entry.source_kind,
      folio,
      lines: entryLines.map((line) => {
        const account = accountMap.get(line.account_id);
        return {
          accountCode: account?.code ?? "—",
          accountName: account?.name ?? "Unknown account",
          debit: line.debit,
          credit: line.credit,
          memo: line.memo || "",
        };
      }),
    };
  });

  return (
    <div className="space-y-6">
      <CompanyContextHeader activeLegalEntity={session.activeLegalEntity} />
      <header className="page-header">
        <h1>General ledger</h1>
        <p>The general journal — every debit has its credit, ruled and dated.</p>
      </header>
      <LedgerBook entries={ledgerEntries} />
    </div>
  );
}
