import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { authoritativeAmountPaidByDocuments } from "@/lib/accounting/allocations";
import {
  batchWriteOffsForDocuments,
  documentRemainingBalance,
} from "@/lib/accounting/balances";
import { batchCreditsAppliedToDocuments } from "@/lib/accounting/document-allocations";
import { roundMoney } from "@/lib/accounting/payment-fees";
import type { CashFlowLine, CashHorizonWeek } from "./types";
import { resolveArCollectionDate, type PartyTimingOverrides } from "./timing";
import { bucketDateIntoHorizon } from "./weeks";

export type OpenReceivable = {
  documentId: string;
  number: string;
  partyId: string | null;
  partyName: string;
  issueDate: string;
  dueDate: string | null;
  remainingBalance: number;
};

export async function loadOpenReceivables(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<OpenReceivable[]> {
  const { data: invoices, error } = await supabase
    .from("teller_documents")
    .select("id, number, total, party_id, status, issue_date, due_date, posted_entry_id")
    .eq("organization_id", organizationId)
    .eq("kind", "invoice")
    .in("status", ["open", "partially_paid"])
    .not("posted_entry_id", "is", null);

  if (error) throw new Error(error.message);

  const rows = invoices ?? [];
  if (!rows.length) return [];

  const invoiceIds = rows.map((row) => row.id as string);
  const [paidMap, creditsMap, writeOffMap] = await Promise.all([
    authoritativeAmountPaidByDocuments(supabase, organizationId, invoiceIds),
    batchCreditsAppliedToDocuments(supabase, organizationId, invoiceIds),
    batchWriteOffsForDocuments(supabase, organizationId, invoiceIds),
  ]);

  const partyIds = [...new Set(rows.map((r) => r.party_id as string | null).filter(Boolean))];
  const partyNames = new Map<string, string>();
  if (partyIds.length) {
    const { data: parties } = await supabase
      .from("teller_parties")
      .select("id, name")
      .eq("organization_id", organizationId)
      .in("id", partyIds);
    for (const party of parties ?? []) {
      partyNames.set(party.id as string, party.name as string);
    }
  }

  const open: OpenReceivable[] = [];
  for (const invoice of rows) {
    const id = invoice.id as string;
    const paid = paidMap.get(id) ?? 0;
    const credits = creditsMap.get(id) ?? 0;
    const writeOffs = writeOffMap.get(id) ?? 0;
    const remaining = documentRemainingBalance(
      asNumber(invoice.total),
      roundMoney(paid + credits + writeOffs),
    );
    if (remaining <= 0.009) continue;

    const partyId = (invoice.party_id as string | null) ?? null;
    open.push({
      documentId: id,
      number: (invoice.number as string) || id.slice(0, 8),
      partyId,
      partyName: partyId ? partyNames.get(partyId) ?? "Customer" : "Customer",
      issueDate: invoice.issue_date as string,
      dueDate: (invoice.due_date as string | null) ?? null,
      remainingBalance: remaining,
    });
  }

  return open;
}

export function projectArCollections(input: {
  receivables: OpenReceivable[];
  horizonWeeks: CashHorizonWeek[];
  horizonStart: string;
  horizonEnd: string;
  defaultArDays: number;
  partyOverrides: PartyTimingOverrides;
}): { lines: CashFlowLine[]; overdueCount: number; defaultTimingCount: number } {
  const lines: CashFlowLine[] = [];
  let overdueCount = 0;
  let defaultTimingCount = 0;

  for (const receivable of input.receivables) {
    const timing = resolveArCollectionDate({
      issueDate: receivable.issueDate,
      dueDate: receivable.dueDate,
      partyId: receivable.partyId,
      defaultArDays: input.defaultArDays,
      partyOverrides: input.partyOverrides,
    });
    if (timing.usedDefault) defaultTimingCount += 1;

    const bucket = bucketDateIntoHorizon(
      timing.date,
      input.horizonStart,
      input.horizonEnd,
      input.horizonWeeks,
    );

    const overdue = bucket.kind === "overdue";
    if (overdue) overdueCount += 1;

    const weekIndex =
      bucket.kind === "week"
        ? bucket.weekIndex
        : bucket.kind === "overdue"
          ? 1
          : null;

    const week =
      weekIndex != null ? input.horizonWeeks.find((w) => w.weekIndex === weekIndex) : null;

    lines.push({
      weekIndex,
      periodStart: week?.periodStart ?? null,
      periodEnd: week?.periodEnd ?? null,
      flowKind: "inflow",
      category: "ar_collection",
      amount: receivable.remainingBalance,
      sourceKind: "ar_invoice",
      sourceId: receivable.documentId,
      label: `INV-${receivable.number}`,
      explanation: `AR — ${receivable.partyName} — INV-${receivable.number}`,
      overdue,
      beyondHorizon: bucket.kind === "beyond",
      metadata: {
        partyId: receivable.partyId,
        collectionDate: timing.date,
      },
    });
  }

  return { lines, overdueCount, defaultTimingCount };
}
