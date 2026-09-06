import { NextResponse } from "next/server";
import { authoritativeDocumentRemaining } from "@/lib/accounting/balances";
import { computeCustomerNetPosition } from "@/lib/accounting/deposit-reconciliation";
import { batchDepositRemainingForPayments } from "@/lib/accounting/deposits";
import { authoritativeCustomerArBalance } from "@/lib/accounting/party-balances";
import { asNumber } from "@/lib/format";
import { jsonError, requireBooks } from "@/lib/api";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;
  const { id: partyId } = await params;

  const { data: party, error: partyError } = await supabase
    .from("teller_parties")
    .select("id, name, kind")
    .eq("organization_id", organizationId)
    .eq("id", partyId)
    .maybeSingle();

  if (partyError || !party) return jsonError("Customer not found", 404);

  const [{ data: invoices }, { data: deposits }, { data: creditMemos }] = await Promise.all([
    supabase
      .from("teller_documents")
      .select("id, number, total, status, issue_date")
      .eq("organization_id", organizationId)
      .eq("kind", "invoice")
      .eq("party_id", partyId)
      .in("status", ["open", "partially_paid", "paid"])
      .order("issue_date", { ascending: false }),
    supabase
      .from("teller_payments")
      .select("id, amount, payment_date, payment_method, reference_number, status, journal_entry_id")
      .eq("organization_id", organizationId)
      .eq("party_id", partyId)
      .eq("payment_type", "customer_deposit")
      .order("payment_date", { ascending: false }),
    supabase
      .from("teller_documents")
      .select("id, number, total, status, issue_date")
      .eq("organization_id", organizationId)
      .eq("kind", "credit_memo")
      .eq("party_id", partyId)
      .in("status", ["open", "partially_applied", "applied"])
      .order("issue_date", { ascending: false }),
  ]);

  const invoiceRows = invoices ?? [];
  const depositRows = (deposits ?? []).filter((row) => row.status === "posted");
  const remainingMap = await batchDepositRemainingForPayments(
    supabase,
    organizationId,
    depositRows.map((row) => ({ id: row.id as string, amount: asNumber(row.amount) })),
  );

  const openInvoices = await Promise.all(
    invoiceRows.map(async (row) => ({
      ...row,
      remaining: await authoritativeDocumentRemaining(
        supabase,
        organizationId,
        row.id as string,
        asNumber(row.total),
      ),
    })),
  );

  const customerAr = await authoritativeCustomerArBalance(supabase, organizationId, partyId);
  const netPosition = await computeCustomerNetPosition(
    supabase,
    organizationId,
    partyId,
    customerAr.netAr,
  );

  const depositSummary = depositRows.map((row) => {
    const amount = asNumber(row.amount);
    const remaining = remainingMap.get(row.id as string) ?? amount;
    return { ...row, applied: amount - remaining, remaining };
  });

  return NextResponse.json({
    customer: party,
    summary: {
      openInvoiceTotal: openInvoices.reduce((sum, row) => sum + row.remaining, 0),
      unappliedDeposits: netPosition.unappliedDeposits,
      netAr: netPosition.netAr,
      netDue: netPosition.netDue,
    },
    invoices: openInvoices,
    deposits: depositSummary,
    creditMemos: creditMemos ?? [],
  });
}
