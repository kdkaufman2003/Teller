import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { asNumber } from "@/lib/format";
import { recordAuditEvent } from "./audit";
import { accountByCode, accountBySubtype } from "./accounts";
import { documentRemainingBalance } from "./balances";
import { type InvoiceStatus } from "./document-transitions";
import { roundMoney } from "./payment-fees";
import {
  assertOrgPeriodOpen,
  loadOrgAccounts,
  reverseJournalEntry,
} from "./post";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ApplyDepositResult = {
  allocationId: string;
  applicationEntryId: string;
  applicationEventId: string;
  depositRemaining: number;
  invoiceRemaining: number;
  invoiceStatus: InvoiceStatus;
  duplicate: boolean;
  recovered?: boolean;
};

type DepositApplicationRow = {
  id: string;
  payment_id: string;
  document_id: string;
  amount: number;
  application_journal_entry_id: string | null;
  application_event_id: string | null;
};

export function normalizeApplicationEventId(input?: string | null): string {
  if (input?.trim()) {
    const id = input.trim();
    if (!UUID_RE.test(id)) {
      throw new Error("applicationEventId must be a valid UUID.");
    }
    return id;
  }
  return randomUUID();
}

export const normalizeReceiptEventId = normalizeApplicationEventId;

export function assertDepositApplicationIdempotencyMatch(
  existing: DepositApplicationRow,
  input: { paymentId: string; invoiceId: string; amount: number },
): void {
  if (existing.payment_id !== input.paymentId) {
    throw new Error("Idempotency conflict: application event is tied to a different deposit.");
  }
  if (existing.document_id !== input.invoiceId) {
    throw new Error("Idempotency conflict: application event is tied to a different invoice.");
  }
  if (Math.abs(asNumber(existing.amount) - input.amount) > 0.009) {
    throw new Error("Idempotency conflict: application event is tied to a different amount.");
  }
}

type RpcReceiveDepositRow = {
  payment_id: string;
  entry_id: string;
  receipt_event_id: string;
  amount: number;
  unapplied: number;
  duplicate: boolean;
  recovered: boolean;
};

type RpcApplyDepositRow = {
  allocation_id: string;
  application_entry_id: string;
  application_event_id: string;
  deposit_remaining: number;
  invoice_remaining: number;
  invoice_status: string;
  duplicate: boolean;
  recovered: boolean;
};

export function customerDepositsAccount(
  accounts: Awaited<ReturnType<typeof loadOrgAccounts>>,
) {
  return accountBySubtype(accounts, "deposit") || accountByCode(accounts, "2300");
}

/** Unapplied balance remaining on a customer deposit payment. */
export async function authoritativeDepositRemaining(
  supabase: SupabaseClient,
  organizationId: string,
  paymentId: string,
  paymentAmount: number,
): Promise<number> {
  const applied = await sumDepositApplicationsForPayment(supabase, organizationId, paymentId);
  return documentRemainingBalance(paymentAmount, applied);
}

export async function sumDepositApplicationsForPayment(
  supabase: SupabaseClient,
  organizationId: string,
  paymentId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("teller_payment_allocations")
    .select("amount")
    .eq("organization_id", organizationId)
    .eq("payment_id", paymentId)
    .eq("allocation_kind", "deposit_apply");

  if (error) throw new Error(error.message);
  return roundMoney((data ?? []).reduce((sum, row) => sum + asNumber(row.amount), 0));
}

export async function batchDepositRemainingForPayments(
  supabase: SupabaseClient,
  organizationId: string,
  payments: { id: string; amount: number }[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!payments.length) return result;

  const paymentIds = payments.map((p) => p.id);
  for (const p of payments) {
    result.set(p.id, roundMoney(asNumber(p.amount)));
  }

  const { data, error } = await supabase
    .from("teller_payment_allocations")
    .select("payment_id, amount")
    .eq("organization_id", organizationId)
    .in("payment_id", paymentIds)
    .eq("allocation_kind", "deposit_apply");

  if (error) throw new Error(error.message);

  for (const row of data ?? []) {
    const id = row.payment_id as string;
    const current = result.get(id) ?? 0;
    result.set(id, roundMoney(Math.max(0, current - asNumber(row.amount))));
  }

  return result;
}

export async function receiveCustomerDeposit(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    partyId: string;
    jobId?: string | null;
    amount: number;
    paymentDate: string;
    paymentMethod?: string;
    referenceNumber?: string;
    memo?: string;
    externalSource?: string | null;
    externalId?: string | null;
    receiptEventId?: string | null;
    actorId?: string | null;
  },
) {
  const amount = roundMoney(asNumber(input.amount));
  if (amount <= 0.009) throw new Error("Deposit amount must be greater than zero.");
  if (!input.partyId) throw new Error("Customer is required for a deposit.");

  const receiptEventId = normalizeReceiptEventId(input.receiptEventId);

  const accounts = await loadOrgAccounts(supabase, input.organizationId);
  const cash = accountBySubtype(accounts, "bank") || accountByCode(accounts, "1000");
  const deposits = customerDepositsAccount(accounts);
  if (!cash) throw new Error("Cash or bank account is missing");
  if (!deposits) throw new Error("Customer Deposits liability account is missing");

  const { data, error } = await supabase.rpc("teller_receive_customer_deposit", {
    p_organization_id: input.organizationId,
    p_party_id: input.partyId,
    p_amount: amount,
    p_payment_date: input.paymentDate,
    p_cash_account_id: cash.id,
    p_deposits_account_id: deposits.id,
    p_receipt_event_id: receiptEventId,
    p_job_id: input.jobId ?? null,
    p_payment_method: input.paymentMethod ?? null,
    p_reference_number: input.referenceNumber ?? null,
    p_external_source: input.externalSource ?? null,
    p_external_id: input.externalId ?? null,
    p_memo: input.memo ?? null,
  });

  if (error) throw new Error(error.message);

  const row = data as RpcReceiveDepositRow;
  const duplicate = Boolean(row.duplicate);

  if (!duplicate) {
    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "deposit.received",
      resourceKind: "payment",
      resourceId: row.payment_id,
      metadata: {
        partyId: input.partyId,
        amount,
        entryId: row.entry_id,
        receiptEventId,
        unapplied: amount,
        recovered: Boolean(row.recovered),
      },
    });

    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "unapplied_payment.recorded",
      resourceKind: "payment",
      resourceId: row.payment_id,
      metadata: {
        partyId: input.partyId,
        amount,
        paymentType: "customer_deposit",
        receiptEventId,
      },
    });
  }

  return {
    paymentId: row.payment_id,
    entryId: row.entry_id,
    receiptEventId: row.receipt_event_id,
    duplicate,
    recovered: row.recovered || undefined,
    amount: roundMoney(asNumber(row.amount)),
    unapplied: roundMoney(asNumber(row.unapplied)),
  };
}

export async function applyDepositToInvoice(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    paymentId: string;
    invoiceId: string;
    amount: number;
    applicationDate: string;
    applicationEventId?: string | null;
    memo?: string;
    actorId?: string | null;
  },
): Promise<ApplyDepositResult> {
  const amount = roundMoney(asNumber(input.amount));
  if (amount <= 0.009) throw new Error("Application amount must be greater than zero.");

  const applicationEventId = normalizeApplicationEventId(input.applicationEventId);

  const accounts = await loadOrgAccounts(supabase, input.organizationId);
  const deposits = customerDepositsAccount(accounts);
  const ar = accountBySubtype(accounts, "receivable") || accountByCode(accounts, "1100");
  if (!deposits || !ar) throw new Error("Customer Deposits or AR account is missing");

  const { data, error } = await supabase.rpc("teller_apply_deposit_to_invoice", {
    p_organization_id: input.organizationId,
    p_payment_id: input.paymentId,
    p_invoice_id: input.invoiceId,
    p_amount: amount,
    p_application_date: input.applicationDate,
    p_application_event_id: applicationEventId,
    p_deposits_account_id: deposits.id,
    p_ar_account_id: ar.id,
    p_memo: input.memo ?? "",
  });

  if (error) throw new Error(error.message);

  const row = data as RpcApplyDepositRow;
  const duplicate = Boolean(row.duplicate);
  const recovered = Boolean(row.recovered);
  const depositRemaining = roundMoney(asNumber(row.deposit_remaining));
  const invoiceRemaining = roundMoney(asNumber(row.invoice_remaining));

  if (!duplicate) {
    const auditAction =
      depositRemaining <= 0.009 ? "deposit.fully_applied" : "deposit.partially_applied";

    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "deposit.applied",
      resourceKind: "payment",
      resourceId: input.paymentId,
      metadata: {
        invoiceId: input.invoiceId,
        amount,
        allocationId: row.allocation_id,
        applicationEntryId: row.application_entry_id,
        applicationEventId,
        depositRemaining,
        invoiceRemaining,
        recovered,
      },
    });

    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: auditAction,
      resourceKind: "payment",
      resourceId: input.paymentId,
      metadata: {
        invoiceId: input.invoiceId,
        amount,
        applicationEventId,
        depositRemaining,
      },
    });
  }

  return {
    allocationId: row.allocation_id,
    applicationEntryId: row.application_entry_id,
    applicationEventId: row.application_event_id,
    depositRemaining,
    invoiceRemaining,
    invoiceStatus: row.invoice_status as InvoiceStatus,
    duplicate,
    recovered: recovered || undefined,
  };
}

export async function voidCustomerDeposit(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    paymentId: string;
    voidDate: string;
    reason?: string;
    actorId?: string | null;
  },
) {
  const { data: payment, error } = await supabase
    .from("teller_payments")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("id", input.paymentId)
    .maybeSingle();

  if (error || !payment) throw new Error("Deposit payment not found");
  if (payment.payment_type !== "customer_deposit") {
    throw new Error("Only customer deposit payments can be voided through this workflow.");
  }
  if (payment.status === "void") {
    return { ok: true, alreadyVoid: true };
  }

  const applied = await sumDepositApplicationsForPayment(
    supabase,
    input.organizationId,
    input.paymentId,
  );
  if (applied > 0.009) {
    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "deposit.void_blocked",
      resourceKind: "payment",
      resourceId: input.paymentId,
      metadata: { reason: "has_applications", applied },
    });
    throw new Error(
      "Cannot void a deposit with invoice applications. Reverse applications first.",
    );
  }

  await assertOrgPeriodOpen(supabase, input.organizationId, input.voidDate);

  const journalEntryId = payment.journal_entry_id as string | null;
  if (!journalEntryId) throw new Error("Deposit has no receipt journal to reverse.");

  const reversalEntryId = await reverseJournalEntry(supabase, {
    organizationId: input.organizationId,
    entryId: journalEntryId,
    entryDate: input.voidDate,
    memo: input.reason ? `Void deposit · ${input.reason}` : "Void customer deposit",
    sourceId: payment.party_id as string,
    actorId: input.actorId,
  });

  await supabase
    .from("teller_payments")
    .update({
      status: "void",
      voided_at: new Date().toISOString(),
      void_journal_entry_id: reversalEntryId,
      void_reason: input.reason ?? "",
    })
    .eq("id", input.paymentId);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "deposit.reversed",
    resourceKind: "payment",
    resourceId: input.paymentId,
    metadata: { reversalEntryId, reason: input.reason },
  });

  return { ok: true, reversalEntryId };
}
