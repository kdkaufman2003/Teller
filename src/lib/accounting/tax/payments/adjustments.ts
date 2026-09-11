import type { SupabaseClient } from "@supabase/supabase-js";
import { roundMoney } from "../../payment-fees";
import { assertOrgPeriodOpen, postJournal, type JournalLineInput } from "../../post";
import { recordTaxAuditEvent } from "../audit";
import { resolveSalesTaxPayableAccountId } from "../posting/resolve-payable";
import { loadTaxSettings } from "../load-tax-settings";
import type { PostTaxManualAdjustmentInput, PostTaxManualAdjustmentResult } from "./types";

export async function postTaxManualAdjustment(
  supabase: SupabaseClient,
  input: PostTaxManualAdjustmentInput,
): Promise<PostTaxManualAdjustmentResult> {
  if (input.idempotencyKey?.trim()) {
    const { data: existing } = await supabase
      .from("teller_tax_manual_adjustments")
      .select("id, journal_entry_id, tax_transaction_id")
      .eq("organization_id", input.organizationId)
      .eq("idempotency_key", input.idempotencyKey.trim())
      .maybeSingle();
    if (existing?.id) {
      return {
        adjustmentId: existing.id as string,
        journalEntryId: existing.journal_entry_id as string,
        taxTransactionId: existing.tax_transaction_id as string,
      };
    }
  }

  const amount = roundMoney(input.amount);
  if (amount <= 0) throw new Error("Adjustment amount must be greater than zero");

  const { settings, schemaReady } = await loadTaxSettings(supabase, input.organizationId);
  if (!schemaReady) throw new Error("Tax settings schema is not available");

  const payableAccountId = resolveSalesTaxPayableAccountId(settings, amount);
  if (!payableAccountId) throw new Error("Sales tax payable account is not configured");

  const { data: registration } = await supabase
    .from("teller_tax_registrations")
    .select("id, organization_id, authority_id, jurisdiction_key")
    .eq("organization_id", input.organizationId)
    .eq("id", input.registrationId)
    .maybeSingle();
  if (!registration) throw new Error("Tax registration not found");

  const { data: offsetAccount } = await supabase
    .from("teller_accounts")
    .select("organization_id")
    .eq("id", input.offsetAccountId)
    .maybeSingle();
  if (!offsetAccount || offsetAccount.organization_id !== input.organizationId) {
    throw new Error("Offset account must belong to organization");
  }

  if (input.filingPeriodId) {
    const { data: period } = await supabase
      .from("teller_tax_filing_periods")
      .select("registration_id")
      .eq("organization_id", input.organizationId)
      .eq("id", input.filingPeriodId)
      .maybeSingle();
    if (!period) throw new Error("Filing period not found");
    if (period.registration_id !== input.registrationId) {
      throw new Error("Filing period registration must match adjustment registration");
    }
  }

  await assertOrgPeriodOpen(supabase, input.organizationId, input.adjustmentDate);

  const lines: JournalLineInput[] =
    input.direction === "increase_liability"
      ? [
          { account_id: input.offsetAccountId, debit: amount, memo: input.reasonNotes || "Tax liability increase" },
          { account_id: payableAccountId, credit: amount, memo: "Tax liability adjustment" },
        ]
      : [
          { account_id: payableAccountId, debit: amount, memo: "Tax liability adjustment" },
          { account_id: input.offsetAccountId, credit: amount, memo: input.reasonNotes || "Tax liability decrease" },
        ];

  const journalEntryId = await postJournal(supabase, {
    organizationId: input.organizationId,
    entryDate: input.adjustmentDate,
    memo: input.reasonNotes || `Tax adjustment (${input.reasonCode})`,
    sourceKind: "tax-manual-adjustment",
    lines,
    actorId: input.actorId,
  });

  const now = new Date().toISOString();
  const { data: adjustment, error: adjustmentError } = await supabase
    .from("teller_tax_manual_adjustments")
    .insert({
      organization_id: input.organizationId,
      registration_id: registration.id,
      filing_period_id: input.filingPeriodId ?? null,
      authority_id: registration.authority_id,
      jurisdiction_key: registration.jurisdiction_key,
      adjustment_date: input.adjustmentDate,
      amount,
      direction: input.direction,
      reason_code: input.reasonCode,
      reason_notes: input.reasonNotes ?? null,
      offset_account_id: input.offsetAccountId,
      status: "posted",
      journal_entry_id: journalEntryId,
      idempotency_key: input.idempotencyKey?.trim() || null,
      created_by: input.actorId ?? null,
    })
    .select("id")
    .single();
  if (adjustmentError || !adjustment) {
    throw new Error(adjustmentError?.message || "Could not persist tax manual adjustment");
  }

  const { data: taxTx, error: taxTxError } = await supabase
    .from("teller_tax_transactions")
    .insert({
      organization_id: input.organizationId,
      transaction_type: "tax_adjustment",
      source_type: "manual_adjustment",
      source_id: adjustment.id,
      determination_status: "resolved",
      transaction_date: input.adjustmentDate,
      taxable_basis: 0,
      tax_amount: amount,
      primary_jurisdiction_key: registration.jurisdiction_key,
      registration_id: registration.id,
      filing_period_id: input.filingPeriodId ?? null,
      authority_id: registration.authority_id,
      is_posted: true,
      posted_at: now,
      posted_journal_entry_id: journalEntryId,
      metadata: {
        manualAdjustment: true,
        adjustmentDirection: input.direction,
        reasonCode: input.reasonCode,
        adjustmentId: adjustment.id,
      },
    })
    .select("id")
    .single();
  if (taxTxError || !taxTx) throw new Error(taxTxError?.message || "Could not persist adjustment tax transaction");

  await supabase
    .from("teller_tax_manual_adjustments")
    .update({ tax_transaction_id: taxTx.id })
    .eq("id", adjustment.id)
    .eq("organization_id", input.organizationId);

  await recordTaxAuditEvent(supabase, {
    organizationId: input.organizationId,
    eventType: "manual_tax_adjustment",
    entityType: "tax_manual_adjustment",
    entityId: adjustment.id as string,
    payload: {
      action: "adjustment_posted",
      direction: input.direction,
      amount,
      reasonCode: input.reasonCode,
    },
    createdBy: input.actorId ?? null,
  });

  return {
    adjustmentId: adjustment.id as string,
    journalEntryId,
    taxTransactionId: taxTx.id as string,
  };
}
