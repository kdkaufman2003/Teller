import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { authoritativeAmountPaidByDocuments } from "./allocations";
import {
  batchCreditsAppliedFromDocuments,
  batchCreditsAppliedToDocuments,
  sumCreditsAppliedFromDocument,
} from "./document-allocations";
import {
  batchCustomerCreditRefundsForMemos,
  sumCustomerCreditRefundsForMemo,
} from "./credits";
import {
  authoritativeDocumentRemaining,
  batchWriteOffsForDocuments,
  documentRemainingBalance,
} from "./balances";
import { roundMoney } from "./payment-fees";

export type PartyArBalance = {
  partyId: string | null;
  invoiceRemaining: number;
  unappliedCredits: number;
  netAr: number;
};

export type PartyApBalance = {
  partyId: string | null;
  billRemaining: number;
  unappliedVendorCredits: number;
  netAp: number;
};

export type ArControlSubledgerBreakdown = {
  invoiceRemainingTotal: number;
  unappliedCreditTotal: number;
  netSubledgerBalance: number;
  invoiceCount: number;
  creditMemoCount: number;
  partyCount: number;
  parties: PartyArBalance[];
};

export type ApControlSubledgerBreakdown = {
  billRemainingTotal: number;
  unappliedVendorCreditTotal: number;
  netSubledgerBalance: number;
  billCount: number;
  vendorCreditCount: number;
  partyCount: number;
  parties: PartyApBalance[];
};

/** Net customer AR = invoice remaining (after applied credits) − unapplied credit balance. */
export function computePartyNetArBalance(
  invoiceRemaining: number,
  unappliedCredits: number,
): number {
  return roundMoney(asNumber(invoiceRemaining) - asNumber(unappliedCredits));
}

/** Net vendor AP = bill remaining (after applied vendor credits) − unapplied vendor credit balance. */
export function computePartyNetApBalance(
  billRemaining: number,
  unappliedVendorCredits: number,
): number {
  return roundMoney(asNumber(billRemaining) - asNumber(unappliedVendorCredits));
}

export async function authoritativeInvoiceRemaining(
  supabase: SupabaseClient,
  organizationId: string,
  invoiceId: string,
  invoiceTotal: number,
): Promise<number> {
  return authoritativeDocumentRemaining(supabase, organizationId, invoiceId, invoiceTotal);
}

export async function authoritativeBillRemaining(
  supabase: SupabaseClient,
  organizationId: string,
  billId: string,
  billTotal: number,
): Promise<number> {
  return authoritativeDocumentRemaining(supabase, organizationId, billId, billTotal);
}

/** Unapplied portion of a posted customer credit memo or vendor credit. */
export async function authoritativeCreditRemaining(
  supabase: SupabaseClient,
  organizationId: string,
  creditDocumentId: string,
  creditTotal: number,
): Promise<number> {
  const [applied, refunded] = await Promise.all([
    sumCreditsAppliedFromDocument(supabase, organizationId, creditDocumentId),
    sumCustomerCreditRefundsForMemo(supabase, organizationId, creditDocumentId),
  ]);
  return documentRemainingBalance(creditTotal, roundMoney(applied + refunded));
}

export const authoritativeVendorCreditRemaining = authoritativeCreditRemaining;

export async function authoritativeCustomerArBalance(
  supabase: SupabaseClient,
  organizationId: string,
  partyId: string | null,
): Promise<PartyArBalance> {
  const breakdown = await computeArControlSubledgerTotal(supabase, organizationId);
  const party =
    breakdown.parties.find((row) => row.partyId === partyId) ??
    ({
      partyId,
      invoiceRemaining: 0,
      unappliedCredits: 0,
      netAr: 0,
    } satisfies PartyArBalance);
  return party;
}

export async function authoritativeVendorApBalance(
  supabase: SupabaseClient,
  organizationId: string,
  partyId: string | null,
): Promise<PartyApBalance> {
  const breakdown = await computeApControlSubledgerTotal(supabase, organizationId);
  const party =
    breakdown.parties.find((row) => row.partyId === partyId) ??
    ({
      partyId,
      billRemaining: 0,
      unappliedVendorCredits: 0,
      netAp: 0,
    } satisfies PartyApBalance);
  return party;
}

export async function computeArControlSubledgerTotal(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<ArControlSubledgerBreakdown> {
  const [{ data: invoices, error: invoiceError }, { data: creditMemos, error: creditError }] =
    await Promise.all([
      supabase
        .from("teller_documents")
        .select("id, total, party_id, status, posted_entry_id")
        .eq("organization_id", organizationId)
        .eq("kind", "invoice")
        .in("status", ["open", "partially_paid", "paid"])
        .not("posted_entry_id", "is", null),
      supabase
        .from("teller_documents")
        .select("id, total, party_id, status, posted_entry_id")
        .eq("organization_id", organizationId)
        .eq("kind", "credit_memo")
        .in("status", ["open", "partially_applied", "applied"])
        .not("posted_entry_id", "is", null),
    ]);

  if (invoiceError) throw new Error(invoiceError.message);
  if (creditError) throw new Error(creditError.message);

  const invoiceRows = invoices ?? [];
  const creditRows = creditMemos ?? [];
  const invoiceIds = invoiceRows.map((row) => row.id as string);
  const creditIds = creditRows.map((row) => row.id as string);

  const [paidMap, creditsToInvoices, creditsFromMemos, creditRefunds, writeOffMap] =
    await Promise.all([
    authoritativeAmountPaidByDocuments(supabase, organizationId, invoiceIds),
    batchCreditsAppliedToDocuments(supabase, organizationId, invoiceIds),
    batchCreditsAppliedFromDocuments(supabase, organizationId, creditIds),
    batchCustomerCreditRefundsForMemos(supabase, organizationId, creditIds),
    batchWriteOffsForDocuments(supabase, organizationId, invoiceIds),
  ]);

  const partyInvoiceRemaining = new Map<string | null, number>();
  let invoiceRemainingTotal = 0;

  for (const invoice of invoiceRows) {
    const id = invoice.id as string;
    const paid = paidMap.get(id) ?? 0;
    const creditsApplied = creditsToInvoices.get(id) ?? 0;
    const writeOffs = writeOffMap.get(id) ?? 0;
    const remaining = documentRemainingBalance(
      asNumber(invoice.total),
      roundMoney(paid + creditsApplied + writeOffs),
    );
    if (remaining <= 0.009) continue;

    invoiceRemainingTotal += remaining;
    const partyId = (invoice.party_id as string | null) ?? null;
    partyInvoiceRemaining.set(
      partyId,
      roundMoney((partyInvoiceRemaining.get(partyId) ?? 0) + remaining),
    );
  }

  const partyUnappliedCredits = new Map<string | null, number>();
  let unappliedCreditTotal = 0;

  for (const credit of creditRows) {
    const id = credit.id as string;
    const applied = creditsFromMemos.get(id) ?? 0;
    const refunded = creditRefunds.get(id) ?? 0;
    const unapplied = documentRemainingBalance(
      asNumber(credit.total),
      roundMoney(applied + refunded),
    );
    if (unapplied <= 0.009) continue;

    unappliedCreditTotal += unapplied;
    const partyId = (credit.party_id as string | null) ?? null;
    partyUnappliedCredits.set(
      partyId,
      roundMoney((partyUnappliedCredits.get(partyId) ?? 0) + unapplied),
    );
  }

  const partyIds = new Set([
    ...partyInvoiceRemaining.keys(),
    ...partyUnappliedCredits.keys(),
  ]);

  const parties: PartyArBalance[] = [...partyIds].map((partyId) => {
    const invoiceRemaining = partyInvoiceRemaining.get(partyId) ?? 0;
    const unappliedCredits = partyUnappliedCredits.get(partyId) ?? 0;
    return {
      partyId,
      invoiceRemaining,
      unappliedCredits,
      netAr: computePartyNetArBalance(invoiceRemaining, unappliedCredits),
    };
  });

  const netSubledgerBalance = roundMoney(invoiceRemainingTotal - unappliedCreditTotal);

  return {
    invoiceRemainingTotal: roundMoney(invoiceRemainingTotal),
    unappliedCreditTotal: roundMoney(unappliedCreditTotal),
    netSubledgerBalance,
    invoiceCount: invoiceRows.length,
    creditMemoCount: creditRows.length,
    partyCount: parties.filter(
      (row) =>
        Math.abs(row.netAr) > 0.009 ||
        row.invoiceRemaining > 0.009 ||
        row.unappliedCredits > 0.009,
    ).length,
    parties,
  };
}

function isApObligationDocument(row: { status: string; kind: string }): boolean {
  if (row.kind !== "expense" && row.kind !== "bill") return false;
  return row.status === "open" || row.status === "partially_paid";
}

export async function computeApControlSubledgerTotal(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<ApControlSubledgerBreakdown> {
  const [{ data: bills, error: billError }, { data: vendorCredits, error: creditError }] =
    await Promise.all([
      supabase
        .from("teller_documents")
        .select("id, total, party_id, status, kind, posted_entry_id")
        .eq("organization_id", organizationId)
        .in("kind", ["bill", "expense"])
        .in("status", ["open", "partially_paid"]),
      supabase
        .from("teller_documents")
        .select("id, total, party_id, status, posted_entry_id")
        .eq("organization_id", organizationId)
        .eq("kind", "vendor_credit")
        .in("status", ["open", "partially_applied", "applied"])
        .not("posted_entry_id", "is", null),
    ]);

  if (billError) throw new Error(billError.message);
  if (creditError) throw new Error(creditError.message);

  const billRows = (bills ?? []).filter(isApObligationDocument);
  const creditRows = vendorCredits ?? [];
  const billIds = billRows.map((row) => row.id as string);
  const creditIds = creditRows.map((row) => row.id as string);

  const [paidMap, creditsToBills, creditsFromVendorCredits] = await Promise.all([
    authoritativeAmountPaidByDocuments(supabase, organizationId, billIds),
    batchCreditsAppliedToDocuments(supabase, organizationId, billIds),
    batchCreditsAppliedFromDocuments(supabase, organizationId, creditIds),
  ]);

  const partyBillRemaining = new Map<string | null, number>();
  let billRemainingTotal = 0;

  for (const bill of billRows) {
    const id = bill.id as string;
    const paid = paidMap.get(id) ?? 0;
    const creditsApplied = creditsToBills.get(id) ?? 0;
    const remaining = documentRemainingBalance(
      asNumber(bill.total),
      roundMoney(paid + creditsApplied),
    );
    if (remaining <= 0.009) continue;

    billRemainingTotal += remaining;
    const partyId = (bill.party_id as string | null) ?? null;
    partyBillRemaining.set(
      partyId,
      roundMoney((partyBillRemaining.get(partyId) ?? 0) + remaining),
    );
  }

  const partyUnappliedVendorCredits = new Map<string | null, number>();
  let unappliedVendorCreditTotal = 0;

  for (const credit of creditRows) {
    const id = credit.id as string;
    const applied = creditsFromVendorCredits.get(id) ?? 0;
    const unapplied = documentRemainingBalance(asNumber(credit.total), applied);
    if (unapplied <= 0.009) continue;

    unappliedVendorCreditTotal += unapplied;
    const partyId = (credit.party_id as string | null) ?? null;
    partyUnappliedVendorCredits.set(
      partyId,
      roundMoney((partyUnappliedVendorCredits.get(partyId) ?? 0) + unapplied),
    );
  }

  const partyIds = new Set([
    ...partyBillRemaining.keys(),
    ...partyUnappliedVendorCredits.keys(),
  ]);

  const parties: PartyApBalance[] = [...partyIds].map((partyId) => {
    const billRemaining = partyBillRemaining.get(partyId) ?? 0;
    const unappliedVendorCredits = partyUnappliedVendorCredits.get(partyId) ?? 0;
    return {
      partyId,
      billRemaining,
      unappliedVendorCredits,
      netAp: computePartyNetApBalance(billRemaining, unappliedVendorCredits),
    };
  });

  const netSubledgerBalance = roundMoney(billRemainingTotal - unappliedVendorCreditTotal);

  return {
    billRemainingTotal: roundMoney(billRemainingTotal),
    unappliedVendorCreditTotal: roundMoney(unappliedVendorCreditTotal),
    netSubledgerBalance,
    billCount: billRows.length,
    vendorCreditCount: creditRows.length,
    partyCount: parties.filter(
      (row) =>
        Math.abs(row.netAp) > 0.009 ||
        row.billRemaining > 0.009 ||
        row.unappliedVendorCredits > 0.009,
    ).length,
    parties,
  };
}

/** Sum party net balances — must equal org net subledger when parties are complete. */
export function sumPartyNetArBalances(parties: PartyArBalance[]): number {
  return roundMoney(parties.reduce((sum, row) => sum + row.netAr, 0));
}

export function sumPartyNetApBalances(parties: PartyApBalance[]): number {
  return roundMoney(parties.reduce((sum, row) => sum + row.netAp, 0));
}
