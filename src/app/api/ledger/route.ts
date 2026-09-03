import { NextResponse } from "next/server";
import { asNumber } from "@/lib/format";
import { jsonError, requireBooks } from "@/lib/api";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const { data: entries, error } = await supabase
    .from("teller_journal_entries")
    .select("id, entry_date, memo, source_kind")
    .eq("organization_id", organizationId)
    .order("entry_date", { ascending: false })
    .limit(50);

  if (error) return jsonError(error.message, 500);

  const ids = (entries ?? []).map((row) => row.id);
  const [{ data: lines }, { data: accounts }] = await Promise.all([
    ids.length
      ? supabase
          .from("teller_journal_lines")
          .select("id, entry_id, account_id, debit, credit, memo")
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

  const balances = new Map<string, { debit: number; credit: number }>();
  for (const line of lines ?? []) {
    const current = balances.get(line.account_id) || { debit: 0, credit: 0 };
    current.debit += asNumber(line.debit);
    current.credit += asNumber(line.credit);
    balances.set(line.account_id, current);
  }

  return NextResponse.json({
    entries: (entries ?? []).map((entry) => ({
      ...entry,
      lines: (lines ?? [])
        .filter((line) => line.entry_id === entry.id)
        .map((line) => ({
          ...line,
          account_name: accountMap.get(line.account_id) || "Account",
        })),
    })),
    trialBalance: (accounts ?? []).map((account) => {
      const bal = balances.get(account.id) || { debit: 0, credit: 0 };
      return {
        id: account.id,
        code: account.code,
        name: account.name,
        debit: bal.debit,
        credit: bal.credit,
        net: bal.debit - bal.credit,
      };
    }),
  });
}
