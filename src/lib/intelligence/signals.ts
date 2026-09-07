import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import {
  buildProfitAndLossForBasis,
  isBilledInvoice,
  reportPeriodRange,
} from "@/lib/accounting/reports";
import { booksClosedThrough } from "@/lib/accounting/periods";
import { parseAccountingBasis, parseFiscalYearStart } from "@/lib/org/config";
import type { IntelligenceContext } from "./types";

export async function gatherIntelligenceContext(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    answers: Record<string, unknown>;
    fiscalYearStart: number;
  },
): Promise<IntelligenceContext> {
  const basis = parseAccountingBasis(input.answers.basis);
  const range = reportPeriodRange("month", new Date(), input.fiscalYearStart);

  const [
    { data: invoices },
    { data: expenses },
    { data: entries },
    { data: accounts },
    { data: expenseAccounts },
    { data: bankTransactions },
    { data: periodCloses },
  ] = await Promise.all([
    supabase
      .from("teller_documents")
      .select("status, total, amount_paid, issue_date, party_id, posted_entry_id")
      .eq("organization_id", input.organizationId)
      .eq("kind", "invoice"),
    supabase
      .from("teller_documents")
      .select("id, status, total, issue_date, memo, metadata")
      .eq("organization_id", input.organizationId)
      .eq("kind", "expense"),
    supabase
      .from("teller_journal_entries")
      .select("id, entry_date, memo")
      .eq("organization_id", input.organizationId)
      .gte("entry_date", range.start ?? "1900-01-01")
      .lte("entry_date", range.end ?? "2999-12-31")
      .order("entry_date", { ascending: false })
      .limit(80),
    supabase
      .from("teller_accounts")
      .select("id, code, name, type")
      .eq("organization_id", input.organizationId),
    supabase
      .from("teller_accounts")
      .select("id, code, name")
      .eq("organization_id", input.organizationId)
      .eq("type", "expense")
      .order("code"),
    supabase
      .from("teller_bank_transactions")
      .select("id, posted_date, amount, normalized_amount, name, merchant_name, status, match_status, match_confidence")
      .eq("organization_id", input.organizationId)
      .order("posted_date", { ascending: false })
      .limit(40),
    supabase
      .from("teller_period_closes")
      .select("period_end, closed_at, effective_closed_through")
      .eq("organization_id", input.organizationId),
  ]);

  const entryIds = (entries ?? []).map((row) => row.id);
  const { data: journalLines } = entryIds.length
    ? await supabase
        .from("teller_journal_lines")
        .select("entry_id, account_id, debit, credit")
        .in("entry_id", entryIds)
    : { data: [] };

  const pl = buildProfitAndLossForBasis(
    basis,
    invoices ?? [],
    (journalLines ?? []).map((line) => ({
      account_id: line.account_id,
      debit: line.debit,
      credit: line.credit,
    })),
    accounts ?? [],
    range,
  );

  const invoiceRows = invoices ?? [];
  const openAR = invoiceRows
    .filter((row) => row.status === "open" && isBilledInvoice(row))
    .reduce((sum, row) => sum + asNumber(row.total) - asNumber(row.amount_paid), 0);
  const collected = invoiceRows
    .filter((row) => row.status === "paid" && isBilledInvoice(row))
    .reduce((sum, row) => sum + asNumber(row.total), 0);
  const openAP = (expenses ?? [])
    .filter((row) => row.status === "open")
    .reduce((sum, row) => sum + asNumber(row.total), 0);

  const debitByEntry = new Map<string, number>();
  for (const line of journalLines ?? []) {
    debitByEntry.set(
      line.entry_id,
      (debitByEntry.get(line.entry_id) ?? 0) + asNumber(line.debit),
    );
  }

  const monthlyRevenue = groupInvoiceRevenue(invoiceRows, basis);

  return {
    netIncome: pl.netIncome,
    totalRevenue: pl.totalRevenue,
    openAR,
    openAP,
    collected,
    periodLabel: range.label,
    closedThrough: booksClosedThrough(periodCloses ?? []),
    journalEntries: (entries ?? []).map((row) => ({
      id: row.id,
      entry_date: row.entry_date,
      memo: row.memo ?? "",
      totalDebit: Math.round((debitByEntry.get(row.id) ?? 0) * 100) / 100,
    })),
    expenses: (expenses ?? []).map((row) => ({
      id: row.id,
      issue_date: row.issue_date,
      total: asNumber(row.total),
      memo: row.memo ?? "",
      status: row.status,
      metadata:
        row.metadata && typeof row.metadata === "object"
          ? (row.metadata as Record<string, unknown>)
          : null,
    })),
    bankTransactions: (bankTransactions ?? []).map((row) => ({
      id: row.id,
      posted_date: row.posted_date,
      amount: asNumber(row.amount),
      name: row.name,
      merchant_name: row.merchant_name,
      status: row.status,
      match_status: row.match_status,
      match_confidence: row.match_confidence,
    })),
    expenseAccounts: expenseAccounts ?? [],
    monthlyRevenue,
  };
}

function groupInvoiceRevenue(
  invoices: {
    status: string;
    total: number | string;
    amount_paid?: number | string;
    issue_date: string;
    posted_entry_id?: string | null;
  }[],
  basis: "cash" | "accrual",
): { month: string; amount: number }[] {
  const totals = new Map<string, number>();
  for (const row of invoices) {
    if (!isBilledInvoice(row)) continue;
    const month = row.issue_date.slice(0, 7);
    const amount =
      basis === "cash" && row.status === "paid"
        ? asNumber(row.total)
        : basis === "accrual"
          ? asNumber(row.total)
          : 0;
    if (amount <= 0) continue;
    totals.set(month, (totals.get(month) ?? 0) + amount);
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, amount]) => ({ month, amount }));
}

export function isAiEnabled(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}
