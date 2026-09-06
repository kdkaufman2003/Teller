import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { asNumber } from "@/lib/format";
import { recordAuditEvent } from "./audit";
import { accountByCode, accountBySubtype } from "./accounts";
import { loadOrgAccounts } from "./post";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeSettlementEventId(input?: string | null): string {
  if (input?.trim()) {
    const id = input.trim();
    if (!UUID_RE.test(id)) throw new Error("Event id must be a valid UUID.");
    return id;
  }
  return randomUUID();
}

export type SettlementRpcResult = {
  duplicate: boolean;
  [key: string]: unknown;
};

function mapRpcRow(row: Record<string, unknown>): SettlementRpcResult {
  return {
    ...row,
    duplicate: Boolean(row.duplicate),
  };
}

export async function refundCustomerPayment(): Promise<never> {
  throw new Error(
    "Invoice payment refunds are not supported. Create a credit memo, then refund available customer credit.",
  );
}

/** Full payment reversal only — no partial amount. Economic refunds use credit memo + refundCustomerCredit. */
export async function reversePayment(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    paymentId: string;
    reversalDate: string;
    reversalEventId?: string | null;
    reason: string;
    actorId?: string | null;
  },
): Promise<SettlementRpcResult & { paymentId?: string; reversalEntryId?: string }> {
  const reversalEventId = normalizeSettlementEventId(input.reversalEventId);
  const { data, error } = await supabase.rpc("teller_reverse_payment", {
    p_organization_id: input.organizationId,
    p_payment_id: input.paymentId,
    p_reversal_date: input.reversalDate,
    p_reversal_event_id: reversalEventId,
    p_reason: input.reason.trim(),
  });
  if (error) throw new Error(error.message);

  const row = mapRpcRow((data ?? {}) as Record<string, unknown>);
  if (!row.duplicate) {
    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "payment.reversed",
      resourceKind: "payment",
      resourceId: input.paymentId,
      metadata: { reversalEventId, reversalEntryId: row.reversal_entry_id },
    });
  }
  return {
    paymentId: row.payment_id as string | undefined,
    reversalEntryId: row.reversal_entry_id as string | undefined,
    duplicate: row.duplicate,
  };
}

export async function reverseDepositApplication(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    allocationId: string;
    reversalDate: string;
    reversalEventId?: string | null;
    reason: string;
    actorId?: string | null;
  },
): Promise<SettlementRpcResult> {
  const reversalEventId = normalizeSettlementEventId(input.reversalEventId);
  const { data, error } = await supabase.rpc("teller_reverse_deposit_application", {
    p_organization_id: input.organizationId,
    p_allocation_id: input.allocationId,
    p_reversal_date: input.reversalDate,
    p_reversal_event_id: reversalEventId,
    p_reason: input.reason.trim(),
  });
  if (error) throw new Error(error.message);
  const row = mapRpcRow((data ?? {}) as Record<string, unknown>);
  if (!row.duplicate) {
    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "deposit.application_reversed",
      resourceKind: "payment_allocation",
      resourceId: input.allocationId,
      metadata: { reversalEventId },
    });
  }
  return row;
}

export async function reverseDocumentAllocation(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    allocationId: string;
    reversalEventId?: string | null;
    reversalDate?: string;
    reason: string;
    actorId?: string | null;
  },
): Promise<SettlementRpcResult> {
  const reversalEventId = normalizeSettlementEventId(input.reversalEventId);
  const { data, error } = await supabase.rpc("teller_reverse_document_allocation", {
    p_organization_id: input.organizationId,
    p_allocation_id: input.allocationId,
    p_reversal_event_id: reversalEventId,
    p_reason: input.reason.trim(),
    p_reversal_date: input.reversalDate ?? new Date().toISOString().slice(0, 10),
  });
  if (error) throw new Error(error.message);
  const row = mapRpcRow((data ?? {}) as Record<string, unknown>);
  if (!row.duplicate) {
    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "credit.application_reversed",
      resourceKind: "document_allocation",
      resourceId: input.allocationId,
      metadata: { reversalEventId },
    });
  }
  return row;
}

export async function refundCustomerDeposit(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    depositPaymentId: string;
    amount: number;
    refundDate: string;
    refundEventId?: string | null;
    reason: string;
    actorId?: string | null;
  },
): Promise<SettlementRpcResult & { refundPaymentId?: string; journalEntryId?: string }> {
  const accounts = await loadOrgAccounts(supabase, input.organizationId);
  const cash = accountBySubtype(accounts, "bank") || accountByCode(accounts, "1000");
  const deposits = accountBySubtype(accounts, "deposit") || accountByCode(accounts, "2300");
  if (!cash || !deposits) {
    throw new Error("Cash or Customer Deposits account is missing.");
  }

  const refundEventId = normalizeSettlementEventId(input.refundEventId);
  const { data, error } = await supabase.rpc("teller_refund_customer_deposit", {
    p_organization_id: input.organizationId,
    p_deposit_payment_id: input.depositPaymentId,
    p_amount: asNumber(input.amount),
    p_refund_date: input.refundDate,
    p_refund_event_id: refundEventId,
    p_reason: input.reason.trim(),
    p_cash_account_id: cash.id,
    p_deposits_account_id: deposits.id,
  });
  if (error) throw new Error(error.message);
  const row = mapRpcRow((data ?? {}) as Record<string, unknown>);
  if (!row.duplicate) {
    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "deposit.refunded",
      resourceKind: "payment",
      resourceId: input.depositPaymentId,
      metadata: { refundEventId, amount: input.amount },
    });
  }
  return {
    refundPaymentId: row.refund_payment_id as string | undefined,
    journalEntryId: row.journal_entry_id as string | undefined,
    duplicate: row.duplicate,
  };
}

export async function writeOffInvoice(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    invoiceId: string;
    amount: number;
    writeoffDate: string;
    writeoffEventId?: string | null;
    reason: string;
    actorId?: string | null;
  },
): Promise<SettlementRpcResult & { writeoffId?: string; journalEntryId?: string }> {
  const accounts = await loadOrgAccounts(supabase, input.organizationId);
  const ar = accountBySubtype(accounts, "receivable") || accountByCode(accounts, "1100");
  const badDebt =
    accountBySubtype(accounts, "bad_debt") || accountByCode(accounts, "6850");
  if (!ar || !badDebt) throw new Error("AR or Bad Debt Expense account is missing.");

  const writeoffEventId = normalizeSettlementEventId(input.writeoffEventId);
  const { data, error } = await supabase.rpc("teller_write_off_invoice", {
    p_organization_id: input.organizationId,
    p_invoice_id: input.invoiceId,
    p_amount: asNumber(input.amount),
    p_writeoff_date: input.writeoffDate,
    p_writeoff_event_id: writeoffEventId,
    p_reason: input.reason.trim(),
    p_bad_debt_account_id: badDebt.id,
    p_ar_account_id: ar.id,
  });
  if (error) throw new Error(error.message);
  const row = mapRpcRow((data ?? {}) as Record<string, unknown>);
  if (!row.duplicate) {
    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "invoice.writeoff",
      resourceKind: "invoice",
      resourceId: input.invoiceId,
      metadata: { writeoffEventId, amount: input.amount },
    });
  }
  return {
    writeoffId: row.writeoff_id as string | undefined,
    journalEntryId: row.journal_entry_id as string | undefined,
    duplicate: row.duplicate,
  };
}

export async function refundCustomerCredit(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    creditMemoId: string;
    amount: number;
    refundDate: string;
    refundEventId?: string | null;
    reason: string;
    actorId?: string | null;
  },
): Promise<SettlementRpcResult & { refundPaymentId?: string; journalEntryId?: string }> {
  const accounts = await loadOrgAccounts(supabase, input.organizationId);
  const cash = accountBySubtype(accounts, "bank") || accountByCode(accounts, "1000");
  const ar = accountBySubtype(accounts, "receivable") || accountByCode(accounts, "1100");
  if (!cash || !ar) throw new Error("Cash or AR account is missing.");

  const refundEventId = normalizeSettlementEventId(input.refundEventId);
  const { data, error } = await supabase.rpc("teller_refund_customer_credit", {
    p_organization_id: input.organizationId,
    p_credit_memo_id: input.creditMemoId,
    p_amount: asNumber(input.amount),
    p_refund_date: input.refundDate,
    p_refund_event_id: refundEventId,
    p_reason: input.reason.trim(),
    p_cash_account_id: cash.id,
    p_ar_account_id: ar.id,
  });
  if (error) throw new Error(error.message);
  const row = mapRpcRow((data ?? {}) as Record<string, unknown>);
  if (!row.duplicate) {
    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "credit_memo.refunded",
      resourceKind: "credit_memo",
      resourceId: input.creditMemoId,
      metadata: { refundEventId, amount: input.amount },
    });
  }
  return {
    refundPaymentId: row.refund_payment_id as string | undefined,
    journalEntryId: row.journal_entry_id as string | undefined,
    duplicate: row.duplicate,
  };
}

export const reverseCustomerPayment = reversePayment;
export const reverseBillPayment = reversePayment;
