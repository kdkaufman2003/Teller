import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { roundMoney } from "./payment-fees";

export function documentRemainingBalance(total: number, amountPaid: number): number {
  return roundMoney(Math.max(0, asNumber(total) - asNumber(amountPaid)));
}

export function validateDocumentPayment(input: {
  documentTotal: number;
  amountPaid: number;
  paymentAmount: number;
}): { remainingBefore: number; paymentAmount: number } {
  const remainingBefore = documentRemainingBalance(input.documentTotal, input.amountPaid);
  if (remainingBefore <= 0.009) {
    throw new Error("Nothing left to pay on this document.");
  }

  const paymentAmount = roundMoney(asNumber(input.paymentAmount));
  if (paymentAmount <= 0.009) {
    throw new Error("Payment amount must be greater than zero.");
  }
  if (paymentAmount > remainingBefore + 0.009) {
    throw new Error(
      `Payment of $${paymentAmount.toFixed(2)} exceeds remaining balance of $${remainingBefore.toFixed(2)}.`,
    );
  }

  return { remainingBefore, paymentAmount };
}

/** Derive amount paid from payment records, reconciled with the document field. */
export async function resolveDocumentAmountPaid(
  supabase: SupabaseClient,
  organizationId: string,
  documentId: string,
  documentAmountPaid: number,
): Promise<number> {
  const { data: payments, error } = await supabase
    .from("teller_payments")
    .select("amount")
    .eq("organization_id", organizationId)
    .eq("document_id", documentId);

  if (error) throw new Error(error.message);

  const paymentsSum = roundMoney(
    (payments ?? []).reduce((sum, row) => sum + asNumber(row.amount), 0),
  );
  const fieldPaid = roundMoney(asNumber(documentAmountPaid));
  return roundMoney(Math.max(paymentsSum, fieldPaid));
}
