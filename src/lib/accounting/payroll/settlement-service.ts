import type { SupabaseClient } from "@supabase/supabase-js";
import { recordAuditEvent } from "../audit";
import { payrollSettlementIdempotencyKey } from "./types";
import {
  assertPayrollJournalBalanced,
  buildPayrollSettlementJournalLines,
} from "./journal-lines";
import {
  atomicPostPayrollSettlementJournal,
  type PayrollSimulateFailureAfter,
} from "./atomic-rpc";

async function findPostedSettlement(
  supabase: SupabaseClient,
  organizationId: string,
  idempotencyKey: string,
): Promise<{ settlementId: string; journalEntryId: string } | null> {
  const { data } = await supabase
    .from("teller_payroll_liability_settlements")
    .select("id, journal_entry_id")
    .eq("organization_id", organizationId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (data?.journal_entry_id) {
    return { settlementId: data.id as string, journalEntryId: data.journal_entry_id as string };
  }
  return null;
}

async function waitForPostedSettlement(
  supabase: SupabaseClient,
  organizationId: string,
  idempotencyKey: string,
  attempts = 25,
): Promise<{ settlementId: string; journalEntryId: string } | null> {
  for (let i = 0; i < attempts; i += 1) {
    const posted = await findPostedSettlement(supabase, organizationId, idempotencyKey);
    if (posted) return posted;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

export async function postPayrollLiabilitySettlement(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    settlementType: "net_pay" | "tax" | "benefit" | "other";
    payrollRunId?: string | null;
    settlementDate: string;
    amount: number;
    liabilityAccountId: string;
    cashAccountId: string;
    actorId?: string | null;
    operationId?: string;
    simulateFailureAfter?: PayrollSimulateFailureAfter | null;
  },
): Promise<{ settlementId: string; journalEntryId: string }> {
  const idempotencyKey =
    input.operationId ??
    payrollSettlementIdempotencyKey(
      input.settlementType,
      input.payrollRunId ?? "none",
      input.amount,
    );

  const existingPosted = await findPostedSettlement(supabase, input.organizationId, idempotencyKey);
  if (existingPosted) return existingPosted;

  const journalLines = buildPayrollSettlementJournalLines({
    settlementType: input.settlementType,
    amount: input.amount,
    liabilityAccountId: input.liabilityAccountId,
    cashAccountId: input.cashAccountId,
  });
  assertPayrollJournalBalanced(journalLines);

  const { data: settlementRow, error: settlementError } = await supabase
    .from("teller_payroll_liability_settlements")
    .insert({
      organization_id: input.organizationId,
      settlement_type: input.settlementType,
      payroll_run_id: input.payrollRunId ?? null,
      settlement_date: input.settlementDate,
      amount: input.amount,
      liability_account_id: input.liabilityAccountId,
      cash_account_id: input.cashAccountId,
      idempotency_key: idempotencyKey,
    })
    .select("id")
    .single();

  if (settlementError || !settlementRow) {
    if (settlementError?.code === "23505") {
      const posted = await waitForPostedSettlement(supabase, input.organizationId, idempotencyKey);
      if (posted) return posted;

      const { data: existing } = await supabase
        .from("teller_payroll_liability_settlements")
        .select("id, journal_entry_id")
        .eq("organization_id", input.organizationId)
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();
      if (existing?.journal_entry_id) {
        return {
          settlementId: existing.id as string,
          journalEntryId: existing.journal_entry_id as string,
        };
      }
      if (existing?.id) {
        const recovered = await atomicPostPayrollSettlementJournal(supabase, {
          organizationId: input.organizationId,
          settlementId: existing.id as string,
          entryDate: input.settlementDate,
          memo: `Payroll ${input.settlementType} settlement`,
          lines: journalLines.map((row) => ({
            account_id: row.accountId,
            debit: row.debit,
            credit: row.credit,
            memo: row.memo,
          })),
          actorId: input.actorId,
          simulateFailureAfter: input.simulateFailureAfter ?? null,
        });
        return {
          settlementId: recovered.settlementId,
          journalEntryId: recovered.journalEntryId,
        };
      }

      throw new Error("Settlement idempotency conflict without posted journal");
    }
    throw new Error(settlementError?.message ?? "Could not create payroll settlement");
  }

  const posted = await atomicPostPayrollSettlementJournal(supabase, {
    organizationId: input.organizationId,
    settlementId: settlementRow.id as string,
    entryDate: input.settlementDate,
    memo: `Payroll ${input.settlementType} settlement`,
    lines: journalLines.map((row) => ({
      account_id: row.accountId,
      debit: row.debit,
      credit: row.credit,
      memo: row.memo,
    })),
    actorId: input.actorId,
    simulateFailureAfter: input.simulateFailureAfter ?? null,
  });

  if (!posted.duplicate) {
    await recordAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: "payroll.settlement.created",
      resourceKind: "payroll_settlement",
      resourceId: settlementRow.id as string,
      metadata: {
        settlementType: input.settlementType,
        amount: input.amount,
        journalEntryId: posted.journalEntryId,
      },
    });
  }

  return { settlementId: posted.settlementId, journalEntryId: posted.journalEntryId };
}
