import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { recordAuditEvent } from "../audit";
import { accountByCode, accountBySubtype } from "../accounts";
import {
  assertSettlementJournalBalanced,
  buildAccrualSettlementJournalLines,
  totalExpenseEffectFromSettlement,
} from "./journal-lines";
import { computeSettlementEconomics, type SettlementBillLine } from "./allocation-engine";
import {
  isOccurrenceEligibleForSettlement,
  toEligibleOccurrence,
  type AccrualOccurrenceRow,
} from "./eligibility";
import { computeOccurrenceSettlementStatus, variancePercent } from "./status";
import type { AccrualAllocationInput, SettlementPreview } from "./types";
import { accrualSettlementIdempotencyKey } from "./types";
import { roundMoney } from "../payment-fees";
import { isActiveSettlementStatus } from "./bill-settlement-guard";
import {
  assertOrgPeriodOpen,
  loadOrgAccounts,
  postJournal,
  reverseJournalEntry,
} from "../post";

type BillLine = {
  amount: number;
  account_id: string | null;
  description: string;
  job_id?: string | null;
  occurrenceId?: string | null;
  settlesAccrual?: boolean;
  taxAmount?: number;
  taxable?: boolean;
  recoverableInputTax?: boolean;
};

function accountTypeById(
  accounts: Array<{ id: string; type: string }>,
  accountId: string | null | undefined,
): string | null {
  if (!accountId) return null;
  return accounts.find((account) => account.id === accountId)?.type ?? null;
}

function recoverableInputTaxAccountId(
  accounts: Array<{ id: string; code: string; type: string; subtype?: string | null }>,
): string | null {
  return (
    accountBySubtype(accounts, "input_tax")?.id ??
    accountBySubtype(accounts, "tax_receivable")?.id ??
    accountByCode(accounts, "1350")?.id ??
    null
  );
}

function toSettlementBillLines(
  lines: BillLine[],
  accounts: Array<{ id: string; type: string }>,
): SettlementBillLine[] {
  return lines.map((line, index) => ({
    lineKey: `line-${index}`,
    amount: asNumber(line.amount),
    account_id: line.account_id,
    description: line.description,
    occurrenceId: line.occurrenceId ?? null,
    settlesAccrual: line.settlesAccrual,
    taxAmount: line.taxAmount,
    taxable: line.taxable,
    recoverableInputTax: line.recoverableInputTax,
    accountType: accountTypeById(accounts, line.account_id),
  }));
}

async function loadSettledAmountByOccurrence(
  supabase: SupabaseClient,
  organizationId: string,
  occurrenceIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (occurrenceIds.length === 0) return map;

  const { data } = await supabase
    .from("teller_accrual_settlement_allocations")
    .select("occurrence_id, applied_amount, teller_accrual_settlements!inner(status)")
    .eq("organization_id", organizationId)
    .eq("status", "posted")
    .in("occurrence_id", occurrenceIds);

  for (const row of data ?? []) {
    const settlement = row.teller_accrual_settlements as unknown as { status: string };
    if (settlement.status !== "posted" && settlement.status !== "partially_settled" && settlement.status !== "settled") {
      continue;
    }
    const id = row.occurrence_id as string;
    map.set(id, roundMoney((map.get(id) ?? 0) + asNumber(row.applied_amount)));
  }
  return map;
}

async function loadOccurrenceRows(
  supabase: SupabaseClient,
  organizationId: string,
  occurrenceIds: string[],
): Promise<AccrualOccurrenceRow[]> {
  const { data, error } = await supabase
    .from("teller_schedule_occurrences")
    .select(
      "id, organization_id, schedule_id, occurrence_date, amount, status, journal_entry_id, teller_accounting_schedules(schedule_type, name, vendor_party_id, liability_account_id, expense_account_id, status)",
    )
    .eq("organization_id", organizationId)
    .in("id", occurrenceIds);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as AccrualOccurrenceRow[];
}

export async function listEligibleAccrualOccurrences(
  supabase: SupabaseClient,
  input: { organizationId: string; billPartyId?: string | null; asOfDate?: string },
) {
  let query = supabase
    .from("teller_schedule_occurrences")
    .select(
      "id, organization_id, schedule_id, occurrence_date, amount, status, journal_entry_id, teller_accounting_schedules!inner(schedule_type, name, vendor_party_id, liability_account_id, expense_account_id, status)",
    )
    .eq("organization_id", input.organizationId)
    .eq("status", "posted")
    .eq("teller_accounting_schedules.schedule_type", "accrued_expense")
    .in("teller_accounting_schedules.status", ["active", "completed"])
    .order("occurrence_date", { ascending: false });

  if (input.asOfDate) {
    query = query.lte("occurrence_date", input.asOfDate.slice(0, 10));
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as unknown as AccrualOccurrenceRow[];
  const settledMap = await loadSettledAmountByOccurrence(
    supabase,
    input.organizationId,
    rows.map((row) => row.id),
  );

  const partyIds = [
    ...new Set(
      rows
        .map((row) => row.teller_accounting_schedules.vendor_party_id)
        .filter(Boolean) as string[],
    ),
  ];
  const partyNames = new Map<string, string>();
  if (partyIds.length > 0) {
    const { data: parties } = await supabase
      .from("teller_parties")
      .select("id, name")
      .eq("organization_id", input.organizationId)
      .in("id", partyIds);
    for (const party of parties ?? []) {
      partyNames.set(party.id as string, party.name as string);
    }
  }

  const eligible: ReturnType<typeof toEligibleOccurrence>[] = [];
  for (const row of rows) {
    const settled = settledMap.get(row.id) ?? 0;
    const check = isOccurrenceEligibleForSettlement(row, {
      organizationId: input.organizationId,
      billPartyId: input.billPartyId,
      settledAmount: settled,
    });
    if (check.eligible) {
      const vendorId = row.teller_accounting_schedules.vendor_party_id;
      eligible.push(
        toEligibleOccurrence(row, settled, vendorId ? partyNames.get(vendorId) : null),
      );
    }
  }
  return eligible;
}

export async function previewAccrualSettlement(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    partyId?: string | null;
    issueDate: string;
    tax: number;
    lines: BillLine[];
    allocations: AccrualAllocationInput[];
  },
): Promise<SettlementPreview> {
  const accounts = await loadOrgAccounts(supabase, input.organizationId);
  const ap = accountBySubtype(accounts, "payable") || accountByCode(accounts, "2000");
  if (!ap) throw new Error("Accounts Payable is missing from the chart of accounts");

  const occurrenceIds = input.allocations.map((allocation) => allocation.occurrenceId);
  const rows = await loadOccurrenceRows(supabase, input.organizationId, occurrenceIds);
  const settledMap = await loadSettledAmountByOccurrence(supabase, input.organizationId, occurrenceIds);

  const accrualRequests = [];
  const previewMeta: SettlementPreview["allocations"] = [];

  for (const allocation of input.allocations) {
    const row = rows.find((candidate) => candidate.id === allocation.occurrenceId);
    if (!row) throw new Error(`Accrual occurrence ${allocation.occurrenceId} not found`);
    const settled = settledMap.get(row.id) ?? 0;
    const check = isOccurrenceEligibleForSettlement(row, {
      organizationId: input.organizationId,
      billPartyId: input.partyId,
      settledAmount: settled,
      applyAmount: allocation.appliedAmount,
    });
    if (!check.eligible) throw new Error(check.reason ?? "Occurrence not eligible");

    const schedule = row.teller_accounting_schedules;
    accrualRequests.push({
      occurrenceId: row.id,
      appliedAmount: roundMoney(allocation.appliedAmount),
      actualAmountAllocated: allocation.actualAmountAllocated,
      liabilityAccountId: schedule.liability_account_id as string,
      expenseAccountId: schedule.expense_account_id as string,
    });
  }

  const economics = computeSettlementEconomics({
    billLines: toSettlementBillLines(input.lines, accounts),
    taxAmount: asNumber(input.tax),
    accrualAllocations: accrualRequests,
    recoverableInputTaxAccountId: recoverableInputTaxAccountId(accounts),
  });

  for (const resolved of economics.accrualAllocations) {
    const row = rows.find((candidate) => candidate.id === resolved.occurrenceId);
    if (!row) continue;
    previewMeta.push({
      occurrenceId: resolved.occurrenceId,
      appliedAmount: resolved.appliedAmount,
      actualAmountAllocated: resolved.actualAmountAllocated,
      actualPreTaxAllocated: resolved.actualPreTaxAllocated,
      nonrecoverableTaxAllocated: resolved.nonrecoverableTaxAllocated,
      recoverableTaxAllocated: resolved.recoverableTaxAllocated,
      varianceAmount: resolved.varianceAmount,
      estimatedAmount: roundMoney(Number(row.amount)),
      liabilityAccountId: resolved.liabilityAccountId,
      expenseAccountId: resolved.expenseAccountId,
    });
  }

  const journalLines = buildAccrualSettlementJournalLines({
    accrualAllocations: economics.accrualAllocations.map((allocation) => ({
      ...allocation,
      partyId: input.partyId ?? null,
      memo: `Settle accrual ${rows.find((row) => row.id === allocation.occurrenceId)?.occurrence_date ?? ""}`,
    })),
    newExpenseDebits: economics.newExpenseDebits.map((line) => ({
      accountId: line.accountId,
      amount: line.amount,
      partyId: input.partyId ?? null,
      memo: line.memo,
    })),
    recoverableTaxDebits: economics.recoverableTaxDebits.map((line) => ({
      accountId: line.accountId,
      amount: line.amount,
      partyId: input.partyId ?? null,
      memo: line.memo,
    })),
    billTotal: economics.billTotal,
    apAccountId: ap.id,
    partyId: input.partyId ?? null,
  });

  assertSettlementJournalBalanced(journalLines);

  const estimatedApplied = roundMoney(
    economics.accrualAllocations.reduce((sum, row) => sum + row.appliedAmount, 0),
  );
  const varianceAmount = roundMoney(
    economics.accrualAllocations.reduce((sum, row) => sum + row.varianceAmount, 0),
  );

  return {
    billTotal: economics.billTotal,
    billSubtotal: economics.billSubtotal,
    estimatedApplied,
    varianceAmount,
    accrualSettlementPortion: economics.accrualSettlementPortion,
    newExpensePortion: economics.newExpensePortion,
    purchaseTaxPortion: economics.purchaseTaxPortion,
    apAmount: economics.billTotal,
    allocations: previewMeta,
    journalLines,
    totalExpenseEffect: totalExpenseEffectFromSettlement({
      accrualAllocations: economics.accrualAllocations,
      newExpenseAmount: economics.newExpensePortion,
    }),
  };
}

export async function postAccrualSettlementWithBill(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    partyId: string | null;
    jobId: string | null;
    issueDate: string;
    number: string;
    tax: number;
    lines: BillLine[];
    allocations: AccrualAllocationInput[];
    actorId?: string | null;
    idempotencyKey?: string | null;
  },
) {
  const idempotencyKey = accrualSettlementIdempotencyKey(input.documentId, input.idempotencyKey);
  const { data: existing } = await supabase
    .from("teller_accrual_settlements")
    .select("id, status, settlement_journal_entry_id")
    .eq("organization_id", input.organizationId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (
    existing?.settlement_journal_entry_id &&
    (existing.status === "posted" || isActiveSettlementStatus(existing.status as string))
  ) {
    return {
      settlementId: existing.id as string,
      journalEntryId: existing.settlement_journal_entry_id as string,
      duplicate: true,
    };
  }

  await assertOrgPeriodOpen(supabase, input.organizationId, input.issueDate);

  const preview = await previewAccrualSettlement(supabase, {
    organizationId: input.organizationId,
    partyId: input.partyId,
    issueDate: input.issueDate,
    tax: input.tax,
    lines: input.lines,
    allocations: input.allocations,
  });

  const { data: settlementRow, error: settlementError } = await supabase
    .from("teller_accrual_settlements")
    .upsert(
      {
        organization_id: input.organizationId,
        bill_id: input.documentId,
        status: "draft",
        settlement_method: "bill_post",
        actual_amount: preview.billTotal,
        estimated_amount: preview.estimatedApplied,
        variance_amount: preview.varianceAmount,
        accrual_settlement_portion: preview.accrualSettlementPortion,
        new_expense_portion: preview.newExpensePortion,
        purchase_tax_portion: preview.purchaseTaxPortion,
        idempotency_key: idempotencyKey,
      },
      { onConflict: "organization_id,idempotency_key" },
    )
    .select("id")
    .single();

  if (settlementError) throw new Error(settlementError.message);
  const settlementId = settlementRow.id as string;

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "accrual.settlement.created",
    resourceKind: "accrual_settlement",
    resourceId: settlementId,
    metadata: { billId: input.documentId, estimated: preview.estimatedApplied, actual: preview.billTotal },
  });

  const entryId = await postJournal(supabase, {
    organizationId: input.organizationId,
    entryDate: input.issueDate,
    memo: `Bill ${input.number} with accrual settlement`,
    sourceKind: "accrual-settlement",
    sourceId: settlementId,
    lines: preview.journalLines,
    actorId: input.actorId,
  });

  for (const allocation of preview.allocations) {
    const { error: allocError } = await supabase.from("teller_accrual_settlement_allocations").insert({
      organization_id: input.organizationId,
      settlement_id: settlementId,
      occurrence_id: allocation.occurrenceId,
      estimated_amount: allocation.estimatedAmount,
      applied_amount: allocation.appliedAmount,
      actual_amount_allocated: allocation.actualAmountAllocated,
      actual_pre_tax_allocated: allocation.actualPreTaxAllocated,
      nonrecoverable_tax_allocated: allocation.nonrecoverableTaxAllocated,
      recoverable_tax_allocated: allocation.recoverableTaxAllocated,
      variance_amount: allocation.varianceAmount,
      accrued_liability_account_id: allocation.liabilityAccountId,
      expense_account_id: allocation.expenseAccountId,
      status: "posted",
    });
    if (allocError) throw new Error(allocError.message);
  }

  const occurrenceIds = preview.allocations.map((allocation) => allocation.occurrenceId);
  const rows = await loadOccurrenceRows(supabase, input.organizationId, occurrenceIds);
  const settledMap = await loadSettledAmountByOccurrence(supabase, input.organizationId, occurrenceIds);

  let anyPartial = false;
  for (const row of rows) {
    const settled = settledMap.get(row.id) ?? 0;
    const status = computeOccurrenceSettlementStatus({
      occurrenceAmount: Number(row.amount),
      settledAmount: settled,
      occurrenceStatus: row.status,
    });
    if (status === "partially_settled") anyPartial = true;
    await supabase
      .from("teller_schedule_occurrences")
      .update({ document_id: input.documentId })
      .eq("id", row.id);
  }

  const headerStatus = anyPartial ? "partially_settled" : "settled";

  await supabase
    .from("teller_accrual_settlements")
    .update({
      status: headerStatus,
      settlement_journal_entry_id: entryId,
      settled_at: new Date().toISOString(),
      settled_by: input.actorId ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", settlementId);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "accrual.settlement.posted",
    resourceKind: "accrual_settlement",
    resourceId: settlementId,
    metadata: {
      billId: input.documentId,
      journalEntryId: entryId,
      variance: preview.varianceAmount,
    },
  });

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "accrual.settlement.linked_to_bill",
    resourceKind: "bill",
    resourceId: input.documentId,
    metadata: { settlementId, occurrenceIds },
  });

  return { settlementId, journalEntryId: entryId, duplicate: false };
}

export async function reverseAccrualSettlement(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    settlementId: string;
    reversalDate: string;
    actorId?: string | null;
  },
) {
  const { data: settlement, error } = await supabase
    .from("teller_accrual_settlements")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("id", input.settlementId)
    .single();
  if (error || !settlement) throw new Error("Settlement not found");
  if (settlement.status === "reversed") throw new Error("Settlement already reversed");
  if (!settlement.settlement_journal_entry_id) throw new Error("Settlement has no posted journal");

  await assertOrgPeriodOpen(supabase, input.organizationId, input.reversalDate);

  const reversalId = await reverseJournalEntry(supabase, {
    organizationId: input.organizationId,
    entryId: settlement.settlement_journal_entry_id as string,
    entryDate: input.reversalDate,
    actorId: input.actorId,
    memo: "Reverse accrual settlement",
    sourceId: input.settlementId,
  });

  await supabase
    .from("teller_accrual_settlement_allocations")
    .update({ status: "reversed" })
    .eq("settlement_id", input.settlementId)
    .eq("organization_id", input.organizationId);

  await supabase
    .from("teller_accrual_settlements")
    .update({
      status: "reversed",
      reversal_journal_entry_id: reversalId,
      reversed_at: new Date().toISOString(),
      reversed_by: input.actorId ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.settlementId);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "accrual.settlement.reversed",
    resourceKind: "accrual_settlement",
    resourceId: input.settlementId,
    metadata: { reversalJournalEntryId: reversalId },
  });

  return { reversalJournalEntryId: reversalId };
}

export { variancePercent };
