import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { accountByCode, accountBySubtype } from "./accounts";
import { batchDepositRemainingForPayments } from "./deposits";
import { roundMoney } from "./payment-fees";

const TOLERANCE = 0.01;

export type DepositReconciliationResult = {
  side: "deposits";
  subledgerUnappliedBalance: number;
  glControlBalance: number;
  difference: number;
  consistent: boolean;
  depositCount: number;
  note: string;
  diagnostics: {
    totalReceived: number;
    totalApplied: number;
    unappliedBalance: number;
    partyCount: number;
    payments: Array<{
      paymentId: string;
      partyId: string | null;
      amount: number;
      applied: number;
      remaining: number;
    }>;
  };
};

type ControlAccountRow = {
  id: string;
  code: string;
  subtype?: string | null;
  type: string;
};

async function fetchGlDepositLiabilityBalance(
  supabase: SupabaseClient,
  organizationId: string,
  control: ControlAccountRow,
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
      return sum + asNumber(line.credit) - asNumber(line.debit);
    }, 0),
  );
}

export async function computeDepositLiabilitySubledger(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{
  unappliedTotal: number;
  totalReceived: number;
  totalApplied: number;
  depositCount: number;
  partyCount: number;
  payments: DepositReconciliationResult["diagnostics"]["payments"];
}> {
  const { data: deposits, error } = await supabase
    .from("teller_payments")
    .select("id, party_id, amount, status")
    .eq("organization_id", organizationId)
    .eq("payment_type", "customer_deposit")
    .eq("status", "posted");

  if (error) throw new Error(error.message);

  const rows = deposits ?? [];
  const remainingMap = await batchDepositRemainingForPayments(
    supabase,
    organizationId,
    rows.map((row) => ({ id: row.id as string, amount: asNumber(row.amount) })),
  );

  let unappliedTotal = 0;
  let totalReceived = 0;
  let totalApplied = 0;
  const partyIds = new Set<string | null>();
  const payments: DepositReconciliationResult["diagnostics"]["payments"] = [];

  for (const row of rows) {
    const id = row.id as string;
    const amount = roundMoney(asNumber(row.amount));
    const remaining = remainingMap.get(id) ?? amount;
    const applied = roundMoney(amount - remaining);

    totalReceived += amount;
    totalApplied += applied;
    unappliedTotal += remaining;
    partyIds.add((row.party_id as string | null) ?? null);

    if (remaining > 0.009) {
      payments.push({
        paymentId: id,
        partyId: (row.party_id as string | null) ?? null,
        amount,
        applied,
        remaining,
      });
    }
  }

  return {
    unappliedTotal: roundMoney(unappliedTotal),
    totalReceived: roundMoney(totalReceived),
    totalApplied: roundMoney(totalApplied),
    depositCount: rows.length,
    partyCount: partyIds.size,
    payments,
  };
}

export async function reconcileDepositsToGl(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<DepositReconciliationResult | null> {
  const { data: accounts, error } = await supabase
    .from("teller_accounts")
    .select("id, code, subtype, type")
    .eq("organization_id", organizationId);

  if (error) throw new Error(error.message);

  const accountRows = (accounts ?? []) as ControlAccountRow[];
  const depositAccount =
    accountBySubtype(accountRows, "deposit") || accountByCode(accountRows, "2300");

  if (!depositAccount) return null;

  const subledger = await computeDepositLiabilitySubledger(supabase, organizationId);
  const glControlBalance = await fetchGlDepositLiabilityBalance(
    supabase,
    organizationId,
    depositAccount,
  );

  const difference = roundMoney(Math.abs(subledger.unappliedTotal - glControlBalance));

  return {
    side: "deposits",
    subledgerUnappliedBalance: subledger.unappliedTotal,
    glControlBalance,
    difference,
    consistent: difference <= TOLERANCE,
    depositCount: subledger.depositCount,
    note:
      "Customer Deposits liability: SUM(unapplied deposit balances) = GL Customer Deposits. Separate from AR reconciliation.",
    diagnostics: {
      totalReceived: subledger.totalReceived,
      totalApplied: subledger.totalApplied,
      unappliedBalance: subledger.unappliedTotal,
      partyCount: subledger.partyCount,
      payments: subledger.payments,
    },
  };
}

/** Customer-facing net due: net AR after credits minus unapplied deposits. */
export async function computeCustomerNetPosition(
  supabase: SupabaseClient,
  organizationId: string,
  partyId: string | null,
  netAr: number,
): Promise<{ netAr: number; unappliedDeposits: number; netDue: number }> {
  const { data: deposits, error } = await supabase
    .from("teller_payments")
    .select("id, amount")
    .eq("organization_id", organizationId)
    .eq("payment_type", "customer_deposit")
    .eq("status", "posted")
    .eq("party_id", partyId);

  if (error) throw new Error(error.message);

  const rows = deposits ?? [];
  const remainingMap = await batchDepositRemainingForPayments(
    supabase,
    organizationId,
    rows.map((row) => ({ id: row.id as string, amount: asNumber(row.amount) })),
  );

  let unappliedDeposits = 0;
  for (const row of rows) {
    unappliedDeposits += remainingMap.get(row.id as string) ?? 0;
  }
  unappliedDeposits = roundMoney(unappliedDeposits);

  return {
    netAr: roundMoney(netAr),
    unappliedDeposits,
    netDue: roundMoney(netAr - unappliedDeposits),
  };
}
