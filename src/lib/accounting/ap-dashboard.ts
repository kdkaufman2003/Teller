import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber, todayISO } from "@/lib/format";
import {
  authoritativeDocumentRemaining,
  enrichDocumentsWithAuthoritativePaid,
} from "./balances";
import { sumCreditsAppliedFromDocument } from "./document-allocations";

export type ApDashboardSummary = {
  totalAp: number;
  dueToday: number;
  dueNext7: number;
  dueNext30: number;
  overdue: number;
  awaitingApproval: number;
  unappliedVendorCredits: number;
  openPurchaseOrders: number;
  cashRequired7: number;
  cashRequired14: number;
  cashRequired30: number;
};

function daysFromToday(dateStr: string, asOf: string): number {
  const asOfDate = new Date(`${asOf}T00:00:00`);
  const due = new Date(`${dateStr}T00:00:00`);
  return Math.floor((due.getTime() - asOfDate.getTime()) / 86400000);
}

export async function buildApDashboardSummary(
  supabase: SupabaseClient,
  organizationId: string,
  asOf = todayISO(),
): Promise<ApDashboardSummary> {
  const [{ data: bills }, { data: credits }, { count: openPoCount }, { count: pendingApproval }] =
    await Promise.all([
      supabase
        .from("teller_documents")
        .select("id, total, status, due_date, issue_date")
        .eq("organization_id", organizationId)
        .eq("kind", "bill")
        .in("status", ["open", "partially_paid", "pending_approval"]),
      supabase
        .from("teller_documents")
        .select("id, total, status")
        .eq("organization_id", organizationId)
        .eq("kind", "vendor_credit")
        .in("status", ["open", "partially_applied"]),
      supabase
        .from("teller_purchase_orders")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .in("status", ["approved", "sent", "partially_received", "received", "partially_billed"]),
      supabase
        .from("teller_documents")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("kind", "bill")
        .eq("status", "pending_approval"),
    ]);

  const enriched = await enrichDocumentsWithAuthoritativePaid(
    supabase,
    organizationId,
    (bills ?? []).filter((row) => row.status !== "pending_approval"),
  );

  let totalAp = 0;
  let dueToday = 0;
  let dueNext7 = 0;
  let dueNext30 = 0;
  let overdue = 0;
  let cashRequired7 = 0;
  let cashRequired14 = 0;
  let cashRequired30 = 0;

  for (const bill of enriched) {
    const remaining = await authoritativeDocumentRemaining(
      supabase,
      organizationId,
      bill.id as string,
      asNumber(bill.total),
    );
    if (remaining <= 0.009) continue;

    totalAp += remaining;
    const dueDate = (bill.due_date as string) || (bill.issue_date as string) || asOf;
    const days = daysFromToday(dueDate, asOf);
    if (days < 0) overdue += remaining;
    else if (days === 0) dueToday += remaining;
    else if (days <= 7) dueNext7 += remaining;
    else if (days <= 30) dueNext30 += remaining;

    if (days <= 7 && days >= 0) cashRequired7 += remaining;
    if (days <= 14 && days >= 0) cashRequired14 += remaining;
    if (days <= 30 && days >= 0) cashRequired30 += remaining;
  }

  let unappliedVendorCredits = 0;
  for (const credit of credits ?? []) {
    const applied = await sumCreditsAppliedFromDocument(
      supabase,
      organizationId,
      credit.id as string,
    );
    const remaining = asNumber(credit.total) - applied;
    if (remaining > 0.009) unappliedVendorCredits += remaining;
  }

  return {
    totalAp: round2(totalAp),
    dueToday: round2(dueToday),
    dueNext7: round2(dueNext7),
    dueNext30: round2(dueNext30),
    overdue: round2(overdue),
    awaitingApproval: pendingApproval ?? 0,
    unappliedVendorCredits: round2(unappliedVendorCredits),
    openPurchaseOrders: openPoCount ?? 0,
    cashRequired7: round2(cashRequired7),
    cashRequired14: round2(cashRequired14),
    cashRequired30: round2(cashRequired30),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
