import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { accountByCode, accountBySubtype } from "./accounts";

type JournalLineInput = {
  account_id: string;
  debit?: number;
  credit?: number;
  party_id?: string | null;
  job_id?: string | null;
  memo?: string;
};

export function assertBalanced(lines: JournalLineInput[]) {
  const debit = lines.reduce((sum, line) => sum + asNumber(line.debit), 0);
  const credit = lines.reduce((sum, line) => sum + asNumber(line.credit), 0);
  if (Math.abs(debit - credit) > 0.009) {
    throw new Error(
      `Journal entry is unbalanced: debit ${debit.toFixed(2)} vs credit ${credit.toFixed(2)}`,
    );
  }
}

export async function postJournal(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    entryDate: string;
    memo: string;
    sourceKind?: string;
    sourceId?: string;
    lines: JournalLineInput[];
  },
) {
  assertBalanced(input.lines);

  const { data: entry, error: entryError } = await supabase
    .from("teller_journal_entries")
    .insert({
      organization_id: input.organizationId,
      entry_date: input.entryDate,
      memo: input.memo,
      source_kind: input.sourceKind ?? null,
      source_id: input.sourceId ?? null,
    })
    .select("id")
    .single();

  if (entryError || !entry) {
    throw new Error(entryError?.message || "Could not create journal entry");
  }

  const { error: lineError } = await supabase.from("teller_journal_lines").insert(
    input.lines.map((line) => ({
      entry_id: entry.id,
      account_id: line.account_id,
      debit: asNumber(line.debit),
      credit: asNumber(line.credit),
      party_id: line.party_id ?? null,
      job_id: line.job_id ?? null,
      memo: line.memo ?? "",
    })),
  );

  if (lineError) {
    throw new Error(lineError.message);
  }

  return entry.id as string;
}

type AccountRow = {
  id: string;
  code: string;
  type: string;
  subtype: string;
};

export async function loadOrgAccounts(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<AccountRow[]> {
  const { data, error } = await supabase
    .from("teller_accounts")
    .select("id, code, type, subtype")
    .eq("organization_id", organizationId)
    .eq("archived", false);
  if (error) throw new Error(error.message);
  return (data ?? []) as AccountRow[];
}

export async function postInvoiceOpen(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    partyId: string | null;
    jobId: string | null;
    issueDate: string;
    number: string;
    tax: number;
    lines: { amount: number; account_id: string | null; description: string }[];
  },
) {
  const accounts = await loadOrgAccounts(supabase, input.organizationId);
  const ar = accountBySubtype(accounts, "receivable") || accountByCode(accounts, "1100");
  const taxPayable = accountBySubtype(accounts, "tax") || accountByCode(accounts, "2100");
  const fallbackRevenue = accounts.find((account) => account.type === "revenue");

  if (!ar) throw new Error("Accounts Receivable is missing from the chart of accounts");

  const journal: JournalLineInput[] = [];
  const subtotal = input.lines.reduce((sum, line) => sum + asNumber(line.amount), 0);
  const tax = asNumber(input.tax);
  const total = subtotal + tax;

  journal.push({
    account_id: ar.id,
    debit: total,
    party_id: input.partyId,
    job_id: input.jobId,
    memo: `Invoice ${input.number}`,
  });

  for (const line of input.lines) {
    const revenueId = line.account_id || fallbackRevenue?.id;
    if (!revenueId) throw new Error("No revenue account available");
    journal.push({
      account_id: revenueId,
      credit: asNumber(line.amount),
      party_id: input.partyId,
      job_id: input.jobId,
      memo: line.description,
    });
  }

  if (tax > 0) {
    if (!taxPayable) throw new Error("Sales tax is on this invoice but no tax payable account exists");
    journal.push({
      account_id: taxPayable.id,
      credit: tax,
      memo: `Tax on ${input.number}`,
    });
  }

  const entryId = await postJournal(supabase, {
    organizationId: input.organizationId,
    entryDate: input.issueDate,
    memo: `Invoice ${input.number}`,
    sourceKind: "invoice",
    sourceId: input.documentId,
    lines: journal,
  });

  const { error } = await supabase
    .from("teller_documents")
    .update({
      status: "open",
      posted_entry_id: entryId,
      subtotal,
      tax,
      total,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.documentId);

  if (error) throw new Error(error.message);
  return entryId;
}

export async function postInvoicePaid(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    partyId: string | null;
    jobId: string | null;
    issueDate: string;
    number: string;
    total: number;
  },
) {
  const accounts = await loadOrgAccounts(supabase, input.organizationId);
  const cash = accountBySubtype(accounts, "bank") || accountByCode(accounts, "1000");
  const ar = accountBySubtype(accounts, "receivable") || accountByCode(accounts, "1100");
  if (!cash || !ar) throw new Error("Cash or AR account is missing");

  const entryId = await postJournal(supabase, {
    organizationId: input.organizationId,
    entryDate: input.issueDate,
    memo: `Payment ${input.number}`,
    sourceKind: "invoice-payment",
    sourceId: input.documentId,
    lines: [
      {
        account_id: cash.id,
        debit: asNumber(input.total),
        party_id: input.partyId,
        job_id: input.jobId,
      },
      {
        account_id: ar.id,
        credit: asNumber(input.total),
        party_id: input.partyId,
        job_id: input.jobId,
      },
    ],
  });

  const { error } = await supabase
    .from("teller_documents")
    .update({
      status: "paid",
      amount_paid: asNumber(input.total),
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.documentId);

  if (error) throw new Error(error.message);
  return entryId;
}

export async function postExpense(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    partyId: string | null;
    jobId: string | null;
    issueDate: string;
    number: string;
    amount: number;
    accountId: string;
    paid: boolean;
  },
) {
  const accounts = await loadOrgAccounts(supabase, input.organizationId);
  const cash = accountBySubtype(accounts, "bank") || accountByCode(accounts, "1000");
  const ap = accountBySubtype(accounts, "payable") || accountByCode(accounts, "2000");
  const creditAccount = input.paid ? cash : ap;
  if (!creditAccount) throw new Error("Cash or AP account is missing");

  const entryId = await postJournal(supabase, {
    organizationId: input.organizationId,
    entryDate: input.issueDate,
    memo: `Expense ${input.number}`,
    sourceKind: "expense",
    sourceId: input.documentId,
    lines: [
      {
        account_id: input.accountId,
        debit: asNumber(input.amount),
        party_id: input.partyId,
        job_id: input.jobId,
      },
      {
        account_id: creditAccount.id,
        credit: asNumber(input.amount),
        party_id: input.partyId,
        job_id: input.jobId,
      },
    ],
  });

  const { error } = await supabase
    .from("teller_documents")
    .update({
      status: input.paid ? "paid" : "open",
      amount_paid: input.paid ? asNumber(input.amount) : 0,
      posted_entry_id: entryId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.documentId);

  if (error) throw new Error(error.message);
  return entryId;
}
