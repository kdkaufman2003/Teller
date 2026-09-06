import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { accountByCode, accountBySubtype } from "./accounts";
import { authoritativeAmountPaidByDocuments } from "./allocations";
import { documentRemainingBalance } from "./balances";
import { roundMoney } from "./payment-fees";

const TOLERANCE = 0.01;

export type SubledgerReconciliationResult = {
  side: "ar" | "ap";
  subledgerOpenBalance: number;
  glControlBalance: number;
  difference: number;
  consistent: boolean;
  documentCount: number;
  note: string;
};

type ControlAccountRow = {
  id: string;
  code: string;
  subtype?: string;
  type: string;
};

async function fetchGlControlBalance(
  supabase: SupabaseClient,
  organizationId: string,
  control: ControlAccountRow,
  side: "ar" | "ap",
): Promise<number> {
  const { data: lines } = await supabase
    .from("teller_journal_lines")
    .select("debit, credit, entry_id")
    .eq("account_id", control.id);

  const entryIds = [...new Set((lines ?? []).map((line) => line.entry_id as string))];
  if (!entryIds.length) return 0;

  const { data: entries } = await supabase
    .from("teller_journal_entries")
    .select("id, reverses_entry_id")
    .eq("organization_id", organizationId)
    .in("id", entryIds);

  const reversalEntries = new Set(
    (entries ?? [])
      .filter((entry) => entry.reverses_entry_id)
      .map((entry) => entry.id as string),
  );

  const { data: reversals } = await supabase
    .from("teller_journal_entries")
    .select("reverses_entry_id")
    .eq("organization_id", organizationId)
    .in("reverses_entry_id", entryIds);

  const reversedOriginals = new Set(
    (reversals ?? []).map((row) => row.reverses_entry_id as string),
  );

  return roundMoney(
    (lines ?? []).reduce((sum, line) => {
      const entryId = line.entry_id as string;
      if (reversalEntries.has(entryId) || reversedOriginals.has(entryId)) return sum;
      if (side === "ar") {
        return sum + asNumber(line.debit) - asNumber(line.credit);
      }
      return sum + asNumber(line.credit) - asNumber(line.debit);
    }, 0),
  );
}

function isApOpenDocument(row: { status: string; kind: string }): boolean {
  if (row.kind !== "expense" && row.kind !== "bill") return false;
  return row.status === "open" || row.status === "partially_paid";
}

function isArOpenDocument(row: { status: string; posted_entry_id?: string | null }): boolean {
  if (row.status === "void" || row.status === "draft") return false;
  if (row.status !== "open" && row.status !== "partially_paid" && row.status !== "paid") {
    return false;
  }
  return Boolean(row.posted_entry_id);
}

export async function computeArOpenSubledgerTotal(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{ total: number; documentCount: number }> {
  const { data: documents, error } = await supabase
    .from("teller_documents")
    .select("id, total, status, posted_entry_id")
    .eq("organization_id", organizationId)
    .eq("kind", "invoice")
    .in("status", ["open", "partially_paid"]);

  if (error) throw new Error(error.message);

  const openDocs = (documents ?? []).filter(isArOpenDocument);
  const paidMap = await authoritativeAmountPaidByDocuments(
    supabase,
    organizationId,
    openDocs.map((row) => row.id as string),
  );

  let total = 0;
  for (const doc of openDocs) {
    const paid = paidMap.get(doc.id as string) ?? 0;
    total += documentRemainingBalance(asNumber(doc.total), paid);
  }

  return { total: roundMoney(total), documentCount: openDocs.length };
}

export async function computeApOpenSubledgerTotal(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{ total: number; documentCount: number }> {
  const { data: documents, error } = await supabase
    .from("teller_documents")
    .select("id, total, status, kind")
    .eq("organization_id", organizationId)
    .in("kind", ["expense", "bill"])
    .in("status", ["open", "partially_paid"]);

  if (error) throw new Error(error.message);

  const openDocs = (documents ?? []).filter(isApOpenDocument);
  const paidMap = await authoritativeAmountPaidByDocuments(
    supabase,
    organizationId,
    openDocs.map((row) => row.id as string),
  );

  let total = 0;
  for (const doc of openDocs) {
    const paid = paidMap.get(doc.id as string) ?? 0;
    total += documentRemainingBalance(asNumber(doc.total), paid);
  }

  return { total: roundMoney(total), documentCount: openDocs.length };
}

export async function reconcileSubledgersToGl(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<SubledgerReconciliationResult[]> {
  const { data: accounts, error } = await supabase
    .from("teller_accounts")
    .select("id, code, subtype, type")
    .eq("organization_id", organizationId);

  if (error) throw new Error(error.message);

  const accountRows = (accounts ?? []) as ControlAccountRow[];
  const arAccount =
    accountBySubtype(accountRows, "receivable") || accountByCode(accountRows, "1100");
  const apAccount =
    accountBySubtype(accountRows, "payable") || accountByCode(accountRows, "2000");

  const [arSubledger, apSubledger] = await Promise.all([
    computeArOpenSubledgerTotal(supabase, organizationId),
    computeApOpenSubledgerTotal(supabase, organizationId),
  ]);

  const results: SubledgerReconciliationResult[] = [];

  if (arAccount) {
    const controlBalance = await fetchGlControlBalance(
      supabase,
      organizationId,
      arAccount,
      "ar",
    );
    const difference = roundMoney(Math.abs(arSubledger.total - controlBalance));
    results.push({
      side: "ar",
      subledgerOpenBalance: arSubledger.total,
      glControlBalance: controlBalance,
      difference,
      consistent: difference <= TOLERANCE,
      documentCount: arSubledger.documentCount,
      note:
        "Open invoice AR only. Customer deposits and unapplied funds are excluded from AR control.",
    });
  }

  if (apAccount) {
    const controlBalance = await fetchGlControlBalance(
      supabase,
      organizationId,
      apAccount,
      "ap",
    );
    const difference = roundMoney(Math.abs(apSubledger.total - controlBalance));
    results.push({
      side: "ap",
      subledgerOpenBalance: apSubledger.total,
      glControlBalance: controlBalance,
      difference,
      consistent: difference <= TOLERANCE,
      documentCount: apSubledger.documentCount,
      note: "Open AP obligations only. Direct paid expenses are excluded.",
    });
  }

  return results;
}
