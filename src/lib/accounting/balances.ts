import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { accountByCode, accountBySubtype } from "./accounts";
import {
  authoritativeAmountPaidByDocuments,
  sumAllocationsForDocument,
} from "./allocations";
import {
  batchCreditsAppliedToDocuments,
  sumCreditsAppliedToDocument,
} from "./document-allocations";
import { roundMoney } from "./payment-fees";

/**
 * Accounting truth hierarchy
 * ---------------------------------
 * 1. teller_payment_allocations (+ posted teller_payments) — primary truth
 * 2. teller_payments.document_id — legacy fallback pre-backfill
 * 3. teller_journal_lines — ledger-derived totals (reconciliation)
 * 4. teller_documents.amount_paid — denormalized cache of CASH PAYMENTS ONLY
 *    (excludes credit applications and write-offs; see teller_refresh_invoice_settlement)
 */

export type DocumentKind = "invoice" | "expense" | "bill";

export type BalanceConsistencyResult = {
  consistent: boolean;
  authoritativePaid: number;
  cachedPaid: number;
  ledgerPaid: number;
  documentTotal: number;
  remainingBalance: number;
};

export function documentRemainingBalance(total: number, amountPaid: number): number {
  return roundMoney(Math.max(0, asNumber(total) - asNumber(amountPaid)));
}

/** Primary accounting truth: sum of posted active allocations for a document. */
export async function authoritativeDocumentAmountPaid(
  supabase: SupabaseClient,
  organizationId: string,
  documentId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from("teller_payment_allocations")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("document_id", documentId);

  if (error) throw new Error(error.message);

  if ((count ?? 0) > 0) {
    return sumAllocationsForDocument(supabase, organizationId, documentId);
  }

  const map = await authoritativeAmountPaidByDocuments(supabase, organizationId, [
    documentId,
  ]);
  return map.get(documentId) ?? 0;
}

/** Ledger-derived payment total for reconciliation checks. */
export async function ledgerDerivedDocumentPaymentTotal(
  supabase: SupabaseClient,
  organizationId: string,
  documentId: string,
  kind: DocumentKind,
): Promise<number> {
  const { data: accounts, error: accountsError } = await supabase
    .from("teller_accounts")
    .select("id, code, type, subtype")
    .eq("organization_id", organizationId);

  if (accountsError) throw new Error(accountsError.message);

  const accountRows = (accounts ?? []) as {
    id: string;
    code: string;
    type: string;
    subtype: string;
  }[];
  const targetAccount =
    kind === "invoice"
      ? accountBySubtype(accountRows, "receivable") || accountByCode(accountRows, "1100")
      : accountBySubtype(accountRows, "payable") || accountByCode(accountRows, "2000");

  if (!targetAccount) return 0;

  const sourceKinds =
    kind === "invoice"
      ? ["invoice-payment", "invoice-payment-fee"]
      : ["expense-payment", "bill-payment"];

  const { data: entries, error: entriesError } = await supabase
    .from("teller_journal_entries")
    .select("id, source_kind, reverses_entry_id")
    .eq("organization_id", organizationId)
    .eq("source_id", documentId)
    .in("source_kind", sourceKinds);

  if (entriesError) throw new Error(entriesError.message);

  const activeEntryIds = (entries ?? [])
    .filter((entry) => !entry.reverses_entry_id)
    .map((entry) => entry.id as string);

  if (!activeEntryIds.length) return 0;

  const { data: reversed } = await supabase
    .from("teller_journal_entries")
    .select("reverses_entry_id")
    .in("reverses_entry_id", activeEntryIds);

  const reversedIds = new Set(
    (reversed ?? []).map((row) => row.reverses_entry_id as string),
  );
  const liveEntryIds = activeEntryIds.filter((id) => !reversedIds.has(id));
  if (!liveEntryIds.length) return 0;

  const { data: lines, error: linesError } = await supabase
    .from("teller_journal_lines")
    .select("debit, credit, account_id, entry_id")
    .in("entry_id", liveEntryIds)
    .eq("account_id", targetAccount.id);

  if (linesError) throw new Error(linesError.message);

  const total = (lines ?? []).reduce((sum, line) => {
    if (kind === "invoice") return sum + asNumber(line.credit);
    return sum + asNumber(line.debit);
  }, 0);

  return roundMoney(total);
}

/** Resolve amount paid from authoritative payment records only. */
export async function resolveDocumentAmountPaid(
  supabase: SupabaseClient,
  organizationId: string,
  documentId: string,
  _documentAmountPaid?: number,
): Promise<number> {
  return authoritativeDocumentAmountPaid(supabase, organizationId, documentId);
}

export function validateDocumentSettlement(input: {
  documentTotal: number;
  amountPaid: number;
  creditsApplied?: number;
  settlementAmount: number;
}): { remainingBefore: number; settlementAmount: number } {
  const creditsApplied = asNumber(input.creditsApplied);
  const settled = roundMoney(asNumber(input.amountPaid) + creditsApplied);
  const remainingBefore = documentRemainingBalance(input.documentTotal, settled);
  if (remainingBefore <= 0.009) {
    throw new Error("Nothing left to settle on this document.");
  }

  const settlementAmount = roundMoney(asNumber(input.settlementAmount));
  if (settlementAmount <= 0.009) {
    throw new Error("Settlement amount must be greater than zero.");
  }
  if (settlementAmount > remainingBefore + 0.009) {
    throw new Error(
      `Settlement of $${settlementAmount.toFixed(2)} exceeds remaining balance of $${remainingBefore.toFixed(2)}.`,
    );
  }

  return { remainingBefore, settlementAmount };
}

/** Authoritative credits applied against a document (non-cash). */
export async function authoritativeDocumentCreditsApplied(
  supabase: SupabaseClient,
  organizationId: string,
  documentId: string,
): Promise<number> {
  return sumCreditsAppliedToDocument(supabase, organizationId, documentId);
}

/** Total settled against a document: cash payments + credit applications. */
export async function authoritativeDocumentSettled(
  supabase: SupabaseClient,
  organizationId: string,
  documentId: string,
): Promise<{ payments: number; credits: number; total: number }> {
  const [payments, credits] = await Promise.all([
    authoritativeDocumentAmountPaid(supabase, organizationId, documentId),
    sumCreditsAppliedToDocument(supabase, organizationId, documentId),
  ]);
  return { payments, credits, total: roundMoney(payments + credits) };
}

/** Remaining balance using authoritative payments, credits, and write-offs. */
export async function authoritativeDocumentRemaining(
  supabase: SupabaseClient,
  organizationId: string,
  documentId: string,
  documentTotal: number,
): Promise<number> {
  const [{ total }, writeOffs] = await Promise.all([
    authoritativeDocumentSettled(supabase, organizationId, documentId),
    sumWriteOffsForDocument(supabase, organizationId, documentId),
  ]);
  return documentRemainingBalance(documentTotal, roundMoney(total + writeOffs));
}

export async function sumWriteOffsForDocument(
  supabase: SupabaseClient,
  organizationId: string,
  documentId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("teller_write_offs")
    .select("amount")
    .eq("organization_id", organizationId)
    .eq("document_id", documentId);

  if (error) {
    if (error.message.includes("teller_write_offs")) return 0;
    throw new Error(error.message);
  }
  return roundMoney((data ?? []).reduce((sum, row) => sum + asNumber(row.amount), 0));
}

export async function batchWriteOffsForDocuments(
  supabase: SupabaseClient,
  organizationId: string,
  documentIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!documentIds.length) return result;
  for (const id of documentIds) result.set(id, 0);

  const { data, error } = await supabase
    .from("teller_write_offs")
    .select("document_id, amount")
    .eq("organization_id", organizationId)
    .in("document_id", documentIds);

  if (error) {
    if (error.message.includes("teller_write_offs")) return result;
    throw new Error(error.message);
  }

  for (const row of data ?? []) {
    const id = row.document_id as string;
    result.set(id, roundMoney((result.get(id) ?? 0) + asNumber(row.amount)));
  }

  return result;
}

/** Batch credit-applied amounts keyed by target document id. */
export async function batchCreditsAppliedToDocumentsMap(
  supabase: SupabaseClient,
  organizationId: string,
  documentIds: string[],
): Promise<Map<string, number>> {
  return batchCreditsAppliedToDocuments(supabase, organizationId, documentIds);
}

export function validateDocumentPayment(input: {
  documentTotal: number;
  amountPaid: number;
  paymentAmount: number;
}): { remainingBefore: number; paymentAmount: number } {
  const remainingBefore = documentRemainingBalance(input.documentTotal, input.amountPaid);
  if (remainingBefore <= 0.009) {
    throw new Error("Nothing left to pay on this document.");
  }

  const paymentAmount = roundMoney(asNumber(input.paymentAmount));
  if (paymentAmount <= 0.009) {
    throw new Error("Payment amount must be greater than zero.");
  }
  if (paymentAmount > remainingBefore + 0.009) {
    throw new Error(
      `Payment of $${paymentAmount.toFixed(2)} exceeds remaining balance of $${remainingBefore.toFixed(2)}.`,
    );
  }

  return { remainingBefore, paymentAmount };
}

export async function checkDocumentBalanceConsistency(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    documentTotal: number;
    cachedAmountPaid: number;
    kind: DocumentKind;
  },
): Promise<BalanceConsistencyResult> {
  const [authoritativePaid, ledgerPaid] = await Promise.all([
    authoritativeDocumentAmountPaid(supabase, input.organizationId, input.documentId),
    ledgerDerivedDocumentPaymentTotal(
      supabase,
      input.organizationId,
      input.documentId,
      input.kind,
    ),
  ]);

  const cachedPaid = roundMoney(asNumber(input.cachedAmountPaid));
  const consistent =
    Math.abs(authoritativePaid - cachedPaid) <= 0.009 &&
    Math.abs(authoritativePaid - ledgerPaid) <= 0.009;

  return {
    consistent,
    authoritativePaid,
    cachedPaid,
    ledgerPaid,
    documentTotal: roundMoney(asNumber(input.documentTotal)),
    remainingBalance: documentRemainingBalance(input.documentTotal, authoritativePaid),
  };
}

export type DocumentCacheRepairResult = {
  repaired: boolean;
  before: number;
  after: number;
};

/** Overlay authoritative amount_paid on document rows for reporting/list views. */
export async function enrichDocumentsWithAuthoritativePaid<
  T extends { id: string; amount_paid?: number | string },
>(supabase: SupabaseClient, organizationId: string, documents: T[]): Promise<T[]> {
  if (!documents.length) return documents;
  const paidMap = await authoritativeAmountPaidByDocuments(
    supabase,
    organizationId,
    documents.map((row) => row.id),
  );
  return documents.map((row) => ({
    ...row,
    amount_paid: paidMap.get(row.id) ?? 0,
  }));
}

/** Repair denormalized amount_paid from authoritative payment records. */
export async function repairDocumentAmountPaidCache(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    cachedAmountPaid: number;
  },
): Promise<DocumentCacheRepairResult> {
  const authoritativePaid = await authoritativeDocumentAmountPaid(
    supabase,
    input.organizationId,
    input.documentId,
  );
  const before = roundMoney(asNumber(input.cachedAmountPaid));

  if (Math.abs(authoritativePaid - before) <= 0.009) {
    return { repaired: false, before, after: before };
  }

  const { error } = await supabase
    .from("teller_documents")
    .update({
      amount_paid: authoritativePaid,
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", input.organizationId)
    .eq("id", input.documentId);

  if (error) throw new Error(error.message);
  return { repaired: true, before, after: authoritativePaid };
}
