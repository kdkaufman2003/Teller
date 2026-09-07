import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { authoritativeAmountPaidByDocuments } from "./allocations";
import {
  batchCreditsAppliedFromDocuments,
  batchCreditsAppliedToDocuments,
} from "./document-allocations";
import { batchCustomerCreditRefundsForMemos } from "./credits";
import { batchWriteOffsForDocuments, documentRemainingBalance } from "./balances";
import {
  computeApControlSubledgerTotal,
  computeArControlSubledgerTotal,
  computePartyNetApBalance,
  computePartyNetArBalance,
} from "./party-balances";
import { agingBucketForDate } from "./aging-service";
import { roundMoney } from "./payment-fees";

export type PartyDocumentBalanceRow = {
  documentId: string;
  number: string;
  kind: string;
  issueDate: string;
  dueDate: string | null;
  total: number;
  remaining: number;
  agingBucket: string;
  status: string;
};

export type PartyBalanceDetailRow = {
  partyId: string;
  partyName: string;
  documentBalance: number;
  unappliedCredits: number;
  netBalance: number;
  openDocuments: PartyDocumentBalanceRow[];
  creditDocuments: PartyDocumentBalanceRow[];
};

export async function loadCustomerBalanceDetails(
  supabase: SupabaseClient,
  organizationId: string,
  asOf: string,
): Promise<PartyBalanceDetailRow[]> {
  const breakdown = await computeArControlSubledgerTotal(supabase, organizationId);
  const { data: parties } = await supabase
    .from("teller_parties")
    .select("id, name")
    .eq("organization_id", organizationId)
    .eq("role", "customer");

  const partyNames = new Map((parties ?? []).map((p) => [p.id as string, p.name as string]));
  const partyIds = new Set([
    ...breakdown.parties.map((p) => p.partyId).filter(Boolean),
    ...(parties ?? []).map((p) => p.id as string),
  ]);

  const [{ data: invoices }, { data: creditMemos }] = await Promise.all([
    supabase
      .from("teller_documents")
      .select("id, number, total, party_id, status, issue_date, due_date, posted_entry_id")
      .eq("organization_id", organizationId)
      .eq("kind", "invoice")
      .in("status", ["open", "partially_paid"])
      .not("posted_entry_id", "is", null),
    supabase
      .from("teller_documents")
      .select("id, number, total, party_id, status, issue_date, due_date, posted_entry_id")
      .eq("organization_id", organizationId)
      .eq("kind", "credit_memo")
      .in("status", ["open", "partially_applied"])
      .not("posted_entry_id", "is", null),
  ]);

  const invoiceIds = (invoices ?? []).map((d) => d.id as string);
  const creditIds = (creditMemos ?? []).map((d) => d.id as string);
  const [paidMap, creditsToInvoices, creditsFromMemos, creditRefunds, writeOffMap] =
    await Promise.all([
      authoritativeAmountPaidByDocuments(supabase, organizationId, invoiceIds),
      batchCreditsAppliedToDocuments(supabase, organizationId, invoiceIds),
      batchCreditsAppliedFromDocuments(supabase, organizationId, creditIds),
      batchCustomerCreditRefundsForMemos(supabase, organizationId, creditIds),
      batchWriteOffsForDocuments(supabase, organizationId, invoiceIds),
    ]);

  const rows: PartyBalanceDetailRow[] = [];

  for (const partyId of partyIds) {
    if (!partyId) continue;
    const sub = breakdown.parties.find((p) => p.partyId === partyId) ?? {
      partyId,
      invoiceRemaining: 0,
      unappliedCredits: 0,
      netAr: 0,
    };

    const openDocuments: PartyDocumentBalanceRow[] = [];
    for (const inv of invoices ?? []) {
      if ((inv.party_id as string | null) !== partyId) continue;
      const id = inv.id as string;
      const remaining = documentRemainingBalance(
        asNumber(inv.total),
        roundMoney(
          (paidMap.get(id) ?? 0) +
            (creditsToInvoices.get(id) ?? 0) +
            (writeOffMap.get(id) ?? 0),
        ),
      );
      if (remaining <= 0.009) continue;
      const due = (inv.due_date as string | null) ?? (inv.issue_date as string);
      openDocuments.push({
        documentId: id,
        number: inv.number as string,
        kind: "invoice",
        issueDate: inv.issue_date as string,
        dueDate: inv.due_date as string | null,
        total: asNumber(inv.total),
        remaining,
        agingBucket: agingBucketForDate(due, asOf),
        status: inv.status as string,
      });
    }

    const creditDocuments: PartyDocumentBalanceRow[] = [];
    for (const cm of creditMemos ?? []) {
      if ((cm.party_id as string | null) !== partyId) continue;
      const id = cm.id as string;
      const remaining = documentRemainingBalance(
        asNumber(cm.total),
        roundMoney((creditsFromMemos.get(id) ?? 0) + (creditRefunds.get(id) ?? 0)),
      );
      if (remaining <= 0.009) continue;
      creditDocuments.push({
        documentId: id,
        number: cm.number as string,
        kind: "credit_memo",
        issueDate: cm.issue_date as string,
        dueDate: cm.due_date as string | null,
        total: asNumber(cm.total),
        remaining,
        agingBucket: "credit",
        status: cm.status as string,
      });
    }

    if (
      sub.invoiceRemaining <= 0.009 &&
      sub.unappliedCredits <= 0.009 &&
      openDocuments.length === 0 &&
      creditDocuments.length === 0
    ) {
      continue;
    }

    rows.push({
      partyId,
      partyName: partyNames.get(partyId) ?? "Unknown customer",
      documentBalance: sub.invoiceRemaining,
      unappliedCredits: sub.unappliedCredits,
      netBalance: computePartyNetArBalance(sub.invoiceRemaining, sub.unappliedCredits),
      openDocuments,
      creditDocuments,
    });
  }

  return rows.sort((a, b) => b.netBalance - a.netBalance);
}

export async function loadVendorBalanceDetails(
  supabase: SupabaseClient,
  organizationId: string,
  asOf: string,
): Promise<PartyBalanceDetailRow[]> {
  const breakdown = await computeApControlSubledgerTotal(supabase, organizationId);
  const { data: parties } = await supabase
    .from("teller_parties")
    .select("id, name")
    .eq("organization_id", organizationId)
    .eq("role", "vendor");

  const partyNames = new Map((parties ?? []).map((p) => [p.id as string, p.name as string]));
  const partyIds = new Set([
    ...breakdown.parties.map((p) => p.partyId).filter(Boolean),
    ...(parties ?? []).map((p) => p.id as string),
  ]);

  const { data: bills } = await supabase
    .from("teller_documents")
    .select("id, number, total, party_id, status, issue_date, due_date, kind, posted_entry_id")
    .eq("organization_id", organizationId)
    .in("kind", ["bill", "expense"])
    .in("status", ["open", "partially_paid"])
    .not("posted_entry_id", "is", null);

  const { data: vendorCredits } = await supabase
    .from("teller_documents")
    .select("id, number, total, party_id, status, issue_date, due_date, posted_entry_id")
    .eq("organization_id", organizationId)
    .eq("kind", "vendor_credit")
    .in("status", ["open", "partially_applied"])
    .not("posted_entry_id", "is", null);

  const billIds = (bills ?? []).map((d) => d.id as string);
  const creditIds = (vendorCredits ?? []).map((d) => d.id as string);
  const [paidMap, creditsToBills, creditsFromVendorCredits] = await Promise.all([
    authoritativeAmountPaidByDocuments(supabase, organizationId, billIds),
    batchCreditsAppliedToDocuments(supabase, organizationId, billIds),
    batchCreditsAppliedFromDocuments(supabase, organizationId, creditIds),
  ]);

  const rows: PartyBalanceDetailRow[] = [];

  for (const partyId of partyIds) {
    if (!partyId) continue;
    const sub = breakdown.parties.find((p) => p.partyId === partyId) ?? {
      partyId,
      billRemaining: 0,
      unappliedVendorCredits: 0,
      netAp: 0,
    };

    const openDocuments: PartyDocumentBalanceRow[] = [];
    for (const doc of bills ?? []) {
      if ((doc.party_id as string | null) !== partyId) continue;
      const id = doc.id as string;
      const remaining = documentRemainingBalance(
        asNumber(doc.total),
        roundMoney((paidMap.get(id) ?? 0) + (creditsToBills.get(id) ?? 0)),
      );
      if (remaining <= 0.009) continue;
      const due = (doc.due_date as string | null) ?? (doc.issue_date as string);
      openDocuments.push({
        documentId: id,
        number: doc.number as string,
        kind: doc.kind as string,
        issueDate: doc.issue_date as string,
        dueDate: doc.due_date as string | null,
        total: asNumber(doc.total),
        remaining,
        agingBucket: agingBucketForDate(due, asOf),
        status: doc.status as string,
      });
    }

    const creditDocuments: PartyDocumentBalanceRow[] = [];
    for (const vc of vendorCredits ?? []) {
      if ((vc.party_id as string | null) !== partyId) continue;
      const id = vc.id as string;
      const remaining = documentRemainingBalance(
        asNumber(vc.total),
        creditsFromVendorCredits.get(id) ?? 0,
      );
      if (remaining <= 0.009) continue;
      creditDocuments.push({
        documentId: id,
        number: vc.number as string,
        kind: "vendor_credit",
        issueDate: vc.issue_date as string,
        dueDate: vc.due_date as string | null,
        total: asNumber(vc.total),
        remaining,
        agingBucket: "credit",
        status: vc.status as string,
      });
    }

    if (
      sub.billRemaining <= 0.009 &&
      sub.unappliedVendorCredits <= 0.009 &&
      openDocuments.length === 0 &&
      creditDocuments.length === 0
    ) {
      continue;
    }

    rows.push({
      partyId,
      partyName: partyNames.get(partyId) ?? "Unknown vendor",
      documentBalance: sub.billRemaining,
      unappliedCredits: sub.unappliedVendorCredits,
      netBalance: computePartyNetApBalance(sub.billRemaining, sub.unappliedVendorCredits),
      openDocuments,
      creditDocuments,
    });
  }

  return rows.sort((a, b) => b.netBalance - a.netBalance);
}
