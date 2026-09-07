import type { SupabaseClient } from "@supabase/supabase-js";
import { recordAuditEvent } from "./audit";
import { assertBalanced, assertOrgPeriodOpen, postJournal, type JournalLineInput } from "./post";
import { roundMoney } from "./payment-fees";
import { asNumber } from "@/lib/format";

export type AdjustmentLine = {
  accountId: string;
  debit?: number;
  credit?: number;
  memo?: string;
  jobId?: string | null;
  fixedAssetId?: string | null;
};

export type AdjustingJournalRecord = {
  id: string;
  organization_id: string;
  adjustment_number: string;
  entry_date: string;
  adjustment_type: string;
  status: string;
  memo: string;
  reference: string;
  lines: AdjustmentLine[];
  journal_entry_id: string | null;
  reversal_journal_entry_id: string | null;
};

function normalizeLines(lines: AdjustmentLine[]): JournalLineInput[] {
  if (lines.length < 2) throw new Error("Adjustment requires at least two lines");
  return lines.map((line) => {
    const debit = roundMoney(asNumber(line.debit));
    const credit = roundMoney(asNumber(line.credit));
    if (debit > 0 && credit > 0) throw new Error("Line cannot have both debit and credit");
    if (debit <= 0 && credit <= 0) throw new Error("Each line must have a debit or credit");
    return {
      account_id: line.accountId,
      debit: debit > 0 ? debit : undefined,
      credit: credit > 0 ? credit : undefined,
      memo: line.memo,
      job_id: line.jobId ?? null,
      fixed_asset_id: line.fixedAssetId ?? null,
    };
  });
}

export async function allocateAdjustmentNumber(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<string> {
  const { count } = await supabase
    .from("teller_adjusting_journal_entries")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId);
  return `AJE-${String((count ?? 0) + 1).padStart(4, "0")}`;
}

export async function createAdjustingJournal(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    entryDate: string;
    memo: string;
    reference?: string;
    adjustmentType?: string;
    lines: AdjustmentLine[];
    actorId?: string | null;
  },
) {
  const journalLines = normalizeLines(input.lines);
  assertBalanced(journalLines);

  const adjustmentNumber = await allocateAdjustmentNumber(supabase, input.organizationId);
  const { data, error } = await supabase
    .from("teller_adjusting_journal_entries")
    .insert({
      organization_id: input.organizationId,
      adjustment_number: adjustmentNumber,
      entry_date: input.entryDate.slice(0, 10),
      adjustment_type: input.adjustmentType ?? "general",
      status: "draft",
      memo: input.memo,
      reference: input.reference ?? "",
      lines: input.lines,
      prepared_by: input.actorId ?? null,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "Could not create adjustment");

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "adjustment.created",
    resourceKind: "adjusting_journal",
    resourceId: data.id as string,
  });

  return data;
}

export async function postAdjustingJournal(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    adjustmentId: string;
    actorId?: string | null;
    approvalRequired?: boolean;
  },
) {
  const { data: row, error } = await supabase
    .from("teller_adjusting_journal_entries")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("id", input.adjustmentId)
    .single();
  if (error || !row) throw new Error(error?.message || "Adjustment not found");

  const status = row.status as string;
  if (input.approvalRequired && status !== "approved") {
    throw new Error("Adjustment must be approved before posting");
  }
  if (!input.approvalRequired && !["draft", "approved", "submitted"].includes(status)) {
    throw new Error(`Cannot post adjustment in status ${status}`);
  }
  if (status === "posted" || status === "reversed") {
    throw new Error("Adjustment already posted");
  }

  const entryDate = row.entry_date as string;
  await assertOrgPeriodOpen(supabase, input.organizationId, entryDate);

  const journalLines = normalizeLines(row.lines as AdjustmentLine[]);
  const entryId = await postJournal(supabase, {
    organizationId: input.organizationId,
    entryDate,
    memo: row.memo as string,
    sourceKind: "adjustment",
    sourceId: row.id as string,
    actorId: input.actorId,
    lines: journalLines,
  });

  const { data: updated, error: updateError } = await supabase
    .from("teller_adjusting_journal_entries")
    .update({
      status: "posted",
      posted_at: new Date().toISOString(),
      posted_by: input.actorId ?? null,
      journal_entry_id: entryId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.adjustmentId)
    .select("*")
    .single();
  if (updateError || !updated) throw new Error(updateError?.message || "Could not update adjustment");

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "adjustment.posted",
    resourceKind: "adjusting_journal",
    resourceId: row.id as string,
    metadata: { journalEntryId: entryId },
  });

  return { adjustment: updated, journalEntryId: entryId };
}

export async function reverseAdjustingJournal(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    adjustmentId: string;
    reversalDate: string;
    reason: string;
    actorId?: string | null;
  },
) {
  const { data: row } = await supabase
    .from("teller_adjusting_journal_entries")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("id", input.adjustmentId)
    .single();
  if (!row) throw new Error("Adjustment not found");
  if (row.status !== "posted") throw new Error("Only posted adjustments can be reversed");
  if (!row.journal_entry_id) throw new Error("Posted adjustment missing journal");

  await assertOrgPeriodOpen(supabase, input.organizationId, input.reversalDate);

  const { reverseJournalEntry } = await import("./post");
  const reversalEntryId = await reverseJournalEntry(supabase, {
    organizationId: input.organizationId,
    entryId: row.journal_entry_id as string,
    entryDate: input.reversalDate.slice(0, 10),
    memo: `Reverse ${row.adjustment_number}: ${input.reason.trim()}`,
    sourceId: row.id as string,
    actorId: input.actorId,
  });

  const { data: updated, error } = await supabase
    .from("teller_adjusting_journal_entries")
    .update({
      status: "reversed",
      reversal_journal_entry_id: reversalEntryId,
      reversal_reason: input.reason.trim(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.adjustmentId)
    .select("*")
    .single();
  if (error || !updated) throw new Error(error?.message || "Could not reverse adjustment");

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "adjustment.reversed",
    resourceKind: "adjusting_journal",
    resourceId: row.id as string,
    metadata: { reversalEntryId, reason: input.reason.trim() },
  });

  return { adjustment: updated, reversalEntryId };
}
