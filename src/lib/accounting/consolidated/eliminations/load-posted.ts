import type { SupabaseClient } from "@supabase/supabase-js";
import { roundMoney } from "../../payment-fees";
import type { EliminationLineRow } from "./types";

export type PostedEliminationAdjustment = {
  entryId: string;
  effectiveDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  entryType: string;
  reversesEntryId: string | null;
  lines: EliminationLineRow[];
};

export async function loadPostedEliminationAdjustments(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    scopeKey: string;
    asOf: string;
    periodStart?: string | null;
    periodEnd?: string | null;
  },
): Promise<PostedEliminationAdjustment[]> {
  const asOf = input.asOf.slice(0, 10);
  const periodStart = input.periodStart?.slice(0, 10) ?? null;
  const periodEnd = input.periodEnd?.slice(0, 10) ?? asOf;

  const [{ data: entries, error }, { data: reversedEntries, error: reversedError }] =
    await Promise.all([
      supabase
        .from("teller_consolidation_elimination_entries")
        .select(
          "id, effective_date, period_start, period_end, entry_type, reverses_entry_id, status, scope_key",
        )
        .eq("organization_id", input.organizationId)
        .eq("scope_key", input.scopeKey)
        .eq("status", "posted")
        .lte("effective_date", asOf),
      supabase
        .from("teller_consolidation_elimination_entries")
        .select("id, reversal_entry_id")
        .eq("organization_id", input.organizationId)
        .eq("scope_key", input.scopeKey)
        .eq("status", "reversed"),
    ]);
  if (error) throw new Error(error.message);
  if (reversedError) throw new Error(reversedError.message);

  const suppressedEntryIds = new Set<string>();
  for (const row of reversedEntries ?? []) {
    if (row.reversal_entry_id) suppressedEntryIds.add(row.reversal_entry_id as string);
  }

  const eligible = (entries ?? []).filter((entry) => {
    if (suppressedEntryIds.has(entry.id as string)) return false;
    const effective = (entry.effective_date as string).slice(0, 10);
    if (effective > asOf) return false;
    const start = entry.period_start ? (entry.period_start as string).slice(0, 10) : null;
    const end = entry.period_end ? (entry.period_end as string).slice(0, 10) : effective;
    if (periodStart && end < periodStart) return false;
    if (periodEnd && start && start > periodEnd) return false;
    return true;
  });

  const entryIds = eligible.map((entry) => entry.id as string);
  if (!entryIds.length) return [];

  const { data: lines, error: lineError } = await supabase
    .from("teller_consolidation_elimination_lines")
    .select(
      "id, entry_id, line_number, group_key, account_type, account_subtype, account_code, account_name, source_legal_entity_id, source_account_id, debit, credit, memo",
    )
    .in("entry_id", entryIds)
    .order("line_number");
  if (lineError) throw new Error(lineError.message);

  const linesByEntry = new Map<string, EliminationLineRow[]>();
  for (const line of lines ?? []) {
    const entryId = line.entry_id as string;
    const bucket = linesByEntry.get(entryId) ?? [];
    bucket.push({
      id: line.id as string,
      lineNumber: line.line_number as number,
      groupKey: line.group_key as string,
      accountType: line.account_type as string,
      accountSubtype: (line.account_subtype as string) ?? "",
      accountCode: line.account_code as string,
      accountName: line.account_name as string,
      sourceLegalEntityId: (line.source_legal_entity_id as string | null) ?? null,
      sourceAccountId: (line.source_account_id as string | null) ?? null,
      debit: roundMoney(Number(line.debit)),
      credit: roundMoney(Number(line.credit)),
      memo: (line.memo as string) ?? "",
    });
    linesByEntry.set(entryId, bucket);
  }

  return eligible.map((entry) => ({
    entryId: entry.id as string,
    effectiveDate: (entry.effective_date as string).slice(0, 10),
    periodStart: entry.period_start ? (entry.period_start as string).slice(0, 10) : null,
    periodEnd: entry.period_end ? (entry.period_end as string).slice(0, 10) : null,
    entryType: entry.entry_type as string,
    reversesEntryId: (entry.reverses_entry_id as string | null) ?? null,
    lines: linesByEntry.get(entry.id as string) ?? [],
  }));
}

export function sumEliminationAdjustmentsByGroupKey(
  adjustments: PostedEliminationAdjustment[],
): Map<string, { debit: number; credit: number }> {
  const totals = new Map<string, { debit: number; credit: number }>();
  for (const adjustment of adjustments) {
    for (const line of adjustment.lines) {
      const existing = totals.get(line.groupKey) ?? { debit: 0, credit: 0 };
      existing.debit = roundMoney(existing.debit + line.debit);
      existing.credit = roundMoney(existing.credit + line.credit);
      totals.set(line.groupKey, existing);
    }
  }
  return totals;
}
