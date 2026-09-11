import type { SupabaseClient } from "@supabase/supabase-js";
import { roundMoney } from "../../payment-fees";
import { assertOrgPeriodOpen, postJournal, type JournalLineInput } from "../../post";
import { recordTaxAuditEvent } from "../audit";
import { assertSameOrganization } from "../tenant-isolation";
import { resolveTaxPaymentAccounts } from "./resolve-accounts";
import type { PostAuthorityTaxPaymentInput, PostAuthorityTaxPaymentResult, TaxAuthorityPaymentStatus } from "./types";

function deriveAllocationStatus(
  baseTaxAmount: number,
  allocatedTotal: number,
): TaxAuthorityPaymentStatus {
  if (allocatedTotal <= 0.009) return "posted";
  if (allocatedTotal + 0.009 < baseTaxAmount) return "partially_allocated";
  return "fully_allocated";
}

export async function postAuthorityTaxPayment(
  supabase: SupabaseClient,
  input: PostAuthorityTaxPaymentInput,
): Promise<PostAuthorityTaxPaymentResult> {
  if (input.idempotencyKey?.trim()) {
    const { data: existing } = await supabase
      .from("teller_tax_authority_payments")
      .select("id, journal_entry_id, tax_transaction_id, total_amount, base_tax_amount, unapplied_amount, status")
      .eq("organization_id", input.organizationId)
      .eq("idempotency_key", input.idempotencyKey.trim())
      .maybeSingle();
    if (existing?.id) {
      const { data: allocations } = await supabase
        .from("teller_tax_authority_payment_allocations")
        .select("id")
        .eq("authority_payment_id", existing.id);
      return {
        paymentId: existing.id as string,
        journalEntryId: existing.journal_entry_id as string,
        taxTransactionId: existing.tax_transaction_id as string,
        totalAmount: Number(existing.total_amount),
        baseTaxAmount: Number(existing.base_tax_amount),
        unappliedAmount: Number(existing.unapplied_amount),
        allocationIds: (allocations ?? []).map((row) => row.id as string),
        status: existing.status as TaxAuthorityPaymentStatus,
      };
    }
  }

  const baseTaxAmount = roundMoney(input.baseTaxAmount);
  const penaltyAmount = roundMoney(input.penaltyAmount ?? 0);
  const interestAmount = roundMoney(input.interestAmount ?? 0);
  if (baseTaxAmount <= 0 && penaltyAmount <= 0 && interestAmount <= 0) {
    throw new Error("Payment must include base tax, penalty, or interest");
  }

  const allocations = input.allocations ?? [];
  let allocatedTotal = 0;
  for (const allocation of allocations) {
    const amount = roundMoney(allocation.amount);
    if (amount <= 0) throw new Error("Each allocation must be greater than zero");
    allocatedTotal = roundMoney(allocatedTotal + amount);
  }
  if (allocatedTotal > baseTaxAmount + 0.009) {
    throw new Error("Allocated base tax exceeds payment base tax amount");
  }

  const { data: registration, error: registrationError } = await supabase
    .from("teller_tax_registrations")
    .select("id, organization_id, authority_id, jurisdiction_key, status")
    .eq("organization_id", input.organizationId)
    .eq("id", input.registrationId)
    .maybeSingle();
  if (registrationError) throw new Error(registrationError.message);
  if (!registration) throw new Error("Tax registration not found");
  if (registration.status !== "active") throw new Error("Tax registration is not active");

  for (const allocation of allocations) {
    const { data: period } = await supabase
      .from("teller_tax_filing_periods")
      .select("id, organization_id, registration_id")
      .eq("organization_id", input.organizationId)
      .eq("id", allocation.filingPeriodId)
      .maybeSingle();
    if (!period) throw new Error("Filing period not found");
    if (period.registration_id !== input.registrationId) {
      throw new Error("Filing period registration must match payment registration");
    }
  }

  await assertOrgPeriodOpen(supabase, input.organizationId, input.paymentDate);

  const accounts = await resolveTaxPaymentAccounts(supabase, input.organizationId, input.cashAccountId);
  if (penaltyAmount > 0 && !accounts.penaltyExpenseAccountId) {
    throw new Error("Tax penalty expense account is not configured");
  }
  if (interestAmount > 0 && !accounts.interestExpenseAccountId) {
    throw new Error("Tax interest expense account is not configured");
  }

  const unappliedAmount = roundMoney(Math.max(baseTaxAmount - allocatedTotal, 0));
  const overpaymentAmount = roundMoney(Math.max(allocatedTotal - baseTaxAmount, 0));
  if (overpaymentAmount > 0.009 && !accounts.overpaymentAccountId) {
    throw new Error("Tax overpayment account is not configured for over-allocated payment");
  }

  const totalAmount = roundMoney(baseTaxAmount + penaltyAmount + interestAmount + overpaymentAmount);
  const lines: JournalLineInput[] = [];

  if (baseTaxAmount > 0) {
    lines.push({
      account_id: accounts.salesTaxPayableAccountId,
      debit: baseTaxAmount,
      memo: "Tax authority payment — base liability",
    });
  }
  if (penaltyAmount > 0) {
    lines.push({
      account_id: accounts.penaltyExpenseAccountId!,
      debit: penaltyAmount,
      memo: "Tax penalty",
    });
  }
  if (interestAmount > 0) {
    lines.push({
      account_id: accounts.interestExpenseAccountId!,
      debit: interestAmount,
      memo: "Tax interest",
    });
  }
  if (overpaymentAmount > 0.009) {
    lines.push({
      account_id: accounts.overpaymentAccountId!,
      debit: overpaymentAmount,
      memo: "Tax overpayment / unapplied",
    });
  }
  lines.push({
    account_id: accounts.cashAccountId,
    credit: totalAmount,
    memo: input.memo || "Tax authority payment",
  });

  const journalEntryId = await postJournal(supabase, {
    organizationId: input.organizationId,
    entryDate: input.paymentDate,
    memo: input.memo || "Tax authority payment",
    sourceKind: "tax-authority-payment",
    lines,
    actorId: input.actorId,
  });

  try {
    return await persistAuthorityTaxPayment(supabase, {
      input,
      registration,
      accounts,
      journalEntryId,
      baseTaxAmount,
      penaltyAmount,
      interestAmount,
      allocatedTotal,
      unappliedAmount,
      allocations,
    });
  } catch (error) {
    const { reverseJournalEntry } = await import("../../post");
    try {
      await reverseJournalEntry(supabase, {
        organizationId: input.organizationId,
        entryId: journalEntryId,
        entryDate: input.paymentDate,
        memo: "Auto-reverse failed tax authority payment",
        sourceId: input.idempotencyKey?.trim() || undefined,
        actorId: input.actorId,
      });
    } catch {
      // Best-effort compensation when payment persistence fails after journal post.
    }
    throw error;
  }
}

async function persistAuthorityTaxPayment(
  supabase: SupabaseClient,
  ctx: {
    input: PostAuthorityTaxPaymentInput;
    registration: { id: string; authority_id: string | null; jurisdiction_key: string | null };
    accounts: Awaited<ReturnType<typeof resolveTaxPaymentAccounts>>;
    journalEntryId: string;
    baseTaxAmount: number;
    penaltyAmount: number;
    interestAmount: number;
    allocatedTotal: number;
    unappliedAmount: number;
    allocations: NonNullable<PostAuthorityTaxPaymentInput["allocations"]>;
  },
): Promise<PostAuthorityTaxPaymentResult> {
  const { input, registration, accounts, journalEntryId, baseTaxAmount, penaltyAmount, interestAmount, unappliedAmount, allocations } = ctx;
  const totalAmount = roundMoney(baseTaxAmount + penaltyAmount + interestAmount + Math.max(ctx.allocatedTotal - baseTaxAmount, 0));
  const status = deriveAllocationStatus(baseTaxAmount, ctx.allocatedTotal);
  const now = new Date().toISOString();

  const { data: payment, error: paymentError } = await supabase
    .from("teller_tax_authority_payments")
    .insert({
      organization_id: input.organizationId,
      registration_id: registration.id,
      authority_id: registration.authority_id,
      jurisdiction_key: registration.jurisdiction_key,
      payment_date: input.paymentDate,
      base_tax_amount: baseTaxAmount,
      penalty_amount: penaltyAmount,
      interest_amount: interestAmount,
      total_amount: totalAmount,
      unapplied_amount: unappliedAmount,
      cash_account_id: accounts.cashAccountId,
      reference_number: input.referenceNumber ?? null,
      memo: input.memo ?? null,
      status,
      journal_entry_id: journalEntryId,
      tax_transaction_id: null,
      idempotency_key: input.idempotencyKey?.trim() || null,
      created_by: input.actorId ?? null,
    })
    .select("id")
    .single();
  if (paymentError || !payment) throw new Error(paymentError?.message || "Could not persist tax authority payment");

  let taxTransactionId = "";
  if (baseTaxAmount > 0) {
    const { data: taxTx, error: taxTxError } = await supabase
      .from("teller_tax_transactions")
      .insert({
        organization_id: input.organizationId,
        transaction_type: "authority_payment",
        source_type: "authority_payment",
        source_id: payment.id,
        determination_status: "resolved",
        transaction_date: input.paymentDate,
        taxable_basis: 0,
        tax_amount: baseTaxAmount,
        primary_jurisdiction_key: registration.jurisdiction_key,
        registration_id: registration.id,
        authority_id: registration.authority_id,
        authority_payment_id: payment.id,
        is_posted: true,
        posted_at: now,
        posted_journal_entry_id: journalEntryId,
        metadata: {
          penaltyAmount,
          interestAmount,
          unappliedAmount,
          referenceNumber: input.referenceNumber ?? null,
        },
      })
      .select("id")
      .single();
    if (taxTxError || !taxTx) throw new Error(taxTxError?.message || "Could not persist tax payment transaction");
    taxTransactionId = taxTx.id as string;
    await supabase
      .from("teller_tax_authority_payments")
      .update({ tax_transaction_id: taxTransactionId, updated_at: now })
      .eq("id", payment.id)
      .eq("organization_id", input.organizationId);
  }

  const allocationIds: string[] = [];
  for (const allocation of allocations) {
    const { data: row, error } = await supabase
      .from("teller_tax_authority_payment_allocations")
      .insert({
        organization_id: input.organizationId,
        authority_payment_id: payment.id,
        filing_period_id: allocation.filingPeriodId,
        registration_id: registration.id,
        allocated_amount: roundMoney(allocation.amount),
      })
      .select("id")
      .single();
    if (error || !row) throw new Error(error?.message || "Could not persist payment allocation");
    allocationIds.push(row.id as string);
  }

  await recordTaxAuditEvent(supabase, {
    organizationId: input.organizationId,
    eventType: "manual_tax_adjustment",
    entityType: "tax_authority_payment",
    entityId: payment.id as string,
    payload: {
      action: "payment_posted",
      baseTaxAmount,
      penaltyAmount,
      interestAmount,
      totalAmount,
      allocationCount: allocationIds.length,
    },
    createdBy: input.actorId ?? null,
  });

  return {
    paymentId: payment.id as string,
    journalEntryId,
    taxTransactionId,
    totalAmount,
    baseTaxAmount,
    unappliedAmount,
    allocationIds,
    status,
  };
}

export async function reverseAuthorityTaxPayment(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    paymentId: string;
    reversalDate: string;
    memo?: string;
    actorId?: string | null;
  },
): Promise<{ reversalJournalEntryId: string; reversalTaxTransactionId: string | null }> {
  const { data: payment, error } = await supabase
    .from("teller_tax_authority_payments")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("id", input.paymentId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!payment) throw new Error("Tax authority payment not found");
  if (payment.status === "reversed" || payment.status === "voided") {
    throw new Error("Tax authority payment is already reversed");
  }

  assertSameOrganization(input.organizationId, payment.organization_id as string, "Tax authority payment");

  const { reverseJournalEntry } = await import("../../post");
  const reversalJournalEntryId = await reverseJournalEntry(supabase, {
    organizationId: input.organizationId,
    entryId: payment.journal_entry_id as string,
    entryDate: input.reversalDate,
    memo: input.memo || `Reverse tax authority payment ${payment.reference_number ?? payment.id}`,
    sourceId: payment.id as string,
    actorId: input.actorId,
  });

  let reversalTaxTransactionId: string | null = null;
  const baseTaxAmount = roundMoney(Number(payment.base_tax_amount));
  if (baseTaxAmount > 0) {
    const { data: registration } = await supabase
      .from("teller_tax_registrations")
      .select("jurisdiction_key, authority_id")
      .eq("id", payment.registration_id)
      .maybeSingle();

    const { data: reversalTx, error: txError } = await supabase
      .from("teller_tax_transactions")
      .insert({
        organization_id: input.organizationId,
        transaction_type: "tax_adjustment",
        source_type: "authority_payment",
        source_id: payment.id,
        determination_status: "resolved",
        transaction_date: input.reversalDate,
        taxable_basis: 0,
        tax_amount: baseTaxAmount,
        primary_jurisdiction_key: registration?.jurisdiction_key ?? payment.jurisdiction_key,
        registration_id: payment.registration_id,
        authority_id: payment.authority_id,
        authority_payment_id: payment.id,
        is_posted: true,
        posted_at: new Date().toISOString(),
        posted_journal_entry_id: reversalJournalEntryId,
        metadata: {
          authorityPaymentReversal: true,
          reversesPaymentId: payment.id,
          reversesTaxTransactionId: payment.tax_transaction_id,
        },
      })
      .select("id")
      .single();
    if (txError || !reversalTx) throw new Error(txError?.message || "Could not persist payment reversal subledger");
    reversalTaxTransactionId = reversalTx.id as string;
  }

  await supabase
    .from("teller_tax_authority_payments")
    .update({
      status: "reversed",
      reversal_journal_entry_id: reversalJournalEntryId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", payment.id)
    .eq("organization_id", input.organizationId);

  await recordTaxAuditEvent(supabase, {
    organizationId: input.organizationId,
    eventType: "manual_tax_adjustment",
    entityType: "tax_authority_payment",
    entityId: payment.id as string,
    payload: { action: "payment_reversed", reversalJournalEntryId },
    createdBy: input.actorId ?? null,
  });

  return { reversalJournalEntryId, reversalTaxTransactionId };
}
