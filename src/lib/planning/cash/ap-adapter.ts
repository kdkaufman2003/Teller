import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { authoritativeAmountPaidByDocuments } from "@/lib/accounting/allocations";
import { batchCreditsAppliedToDocuments } from "@/lib/accounting/document-allocations";
import { documentRemainingBalance } from "@/lib/accounting/balances";
import { roundMoney } from "@/lib/accounting/payment-fees";
import type { CashFlowLine, CashHorizonWeek } from "./types";
import { resolveApPaymentDate, type PartyTimingOverrides } from "./timing";
import { bucketDateIntoHorizon } from "./weeks";

export type OpenPayable = {
  documentId: string;
  number: string;
  kind: string;
  partyId: string | null;
  partyName: string;
  issueDate: string;
  dueDate: string | null;
  remainingBalance: number;
};

function isApObligation(row: { status: string; kind: string }): boolean {
  if (row.kind !== "bill" && row.kind !== "expense") return false;
  return row.status === "open" || row.status === "partially_paid";
}

export async function loadOpenPayables(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<OpenPayable[]> {
  const { data: documents, error } = await supabase
    .from("teller_documents")
    .select("id, number, total, party_id, status, kind, issue_date, due_date, posted_entry_id")
    .eq("organization_id", organizationId)
    .in("kind", ["bill", "expense"])
    .in("status", ["open", "partially_paid"]);

  if (error) throw new Error(error.message);

  const rows = (documents ?? []).filter(isApObligation);
  if (!rows.length) return [];

  const billIds = rows.map((row) => row.id as string);
  const [paidMap, creditsMap] = await Promise.all([
    authoritativeAmountPaidByDocuments(supabase, organizationId, billIds),
    batchCreditsAppliedToDocuments(supabase, organizationId, billIds),
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

  const open: OpenPayable[] = [];
  for (const doc of rows) {
    const id = doc.id as string;
    const paid = paidMap.get(id) ?? 0;
    const credits = creditsMap.get(id) ?? 0;
    const remaining = documentRemainingBalance(
      asNumber(doc.total),
      roundMoney(paid + credits),
    );
    if (remaining <= 0.009) continue;

    const partyId = (doc.party_id as string | null) ?? null;
    open.push({
      documentId: id,
      number: (doc.number as string) || id.slice(0, 8),
      kind: doc.kind as string,
      partyId,
      partyName: partyId ? partyNames.get(partyId) ?? "Vendor" : "Vendor",
      issueDate: doc.issue_date as string,
      dueDate: (doc.due_date as string | null) ?? null,
      remainingBalance: remaining,
    });
  }

  return open;
}

export function projectApPayments(input: {
  payables: OpenPayable[];
  horizonWeeks: CashHorizonWeek[];
  horizonStart: string;
  horizonEnd: string;
  defaultApDays: number;
  partyOverrides: PartyTimingOverrides;
}): { lines: CashFlowLine[]; overdueCount: number; defaultTimingCount: number } {
  const lines: CashFlowLine[] = [];
  let overdueCount = 0;
  let defaultTimingCount = 0;

  for (const payable of input.payables) {
    const timing = resolveApPaymentDate({
      issueDate: payable.issueDate,
      dueDate: payable.dueDate,
      partyId: payable.partyId,
      defaultApDays: input.defaultApDays,
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

    const docLabel = payable.kind === "bill" ? "Bill" : "Expense";

    lines.push({
      weekIndex,
      periodStart: week?.periodStart ?? null,
      periodEnd: week?.periodEnd ?? null,
      flowKind: "outflow",
      category: "ap_payment",
      amount: payable.remainingBalance,
      sourceKind: "ap_bill",
      sourceId: payable.documentId,
      label: `${docLabel} #${payable.number}`,
      explanation: `AP — ${payable.partyName} — ${docLabel} #${payable.number}`,
      overdue,
      beyondHorizon: bucket.kind === "beyond",
      metadata: {
        partyId: payable.partyId,
        paymentDate: timing.date,
      },
    });
  }

  return { lines, overdueCount, defaultTimingCount };
}
