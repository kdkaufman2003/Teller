import type { SupabaseClient } from "@supabase/supabase-js";
import { assertSameOrganization } from "../tenant-isolation";

/** Link an already-posted tax authority payment to a bank transaction without creating cash GL. */
export async function linkAuthorityTaxPaymentToBankTransaction(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    paymentId: string;
    bankTransactionId: string;
    clearedAmount: number;
    clearedDate: string;
    actorId?: string | null;
  },
): Promise<{ matchId: string }> {
  const { data: payment, error: paymentError } = await supabase
    .from("teller_tax_authority_payments")
    .select("id, organization_id, journal_entry_id, total_amount, status")
    .eq("organization_id", input.organizationId)
    .eq("id", input.paymentId)
    .maybeSingle();
  if (paymentError) throw new Error(paymentError.message);
  if (!payment) throw new Error("Tax authority payment not found");
  if (payment.status === "reversed" || payment.status === "voided") {
    throw new Error("Reversed tax payments cannot be bank matched");
  }

  const { data: bankTxn, error: bankError } = await supabase
    .from("teller_bank_transactions")
    .select("id, organization_id")
    .eq("id", input.bankTransactionId)
    .maybeSingle();
  if (bankError) throw new Error(bankError.message);
  if (!bankTxn) throw new Error("Bank transaction not found");
  assertSameOrganization(input.organizationId, bankTxn.organization_id as string, "Bank transaction");

  const { count: existingMatches } = await supabase
    .from("teller_bank_matches")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", input.organizationId)
    .eq("bank_transaction_id", input.bankTransactionId)
    .eq("journal_entry_id", payment.journal_entry_id);

  if ((existingMatches ?? 0) > 0) {
    throw new Error("Bank transaction is already matched to this tax payment journal");
  }

  const { data: match, error: matchError } = await supabase
    .from("teller_bank_matches")
    .insert({
      organization_id: input.organizationId,
      bank_transaction_id: input.bankTransactionId,
      journal_entry_id: payment.journal_entry_id,
      cleared_amount: input.clearedAmount,
      cleared_date: input.clearedDate,
      match_status: "confirmed",
      metadata: {
        taxAuthorityPaymentId: payment.id,
        linkedBy: input.actorId ?? null,
      },
    })
    .select("id")
    .single();
  if (matchError || !match) throw new Error(matchError?.message || "Could not create bank match");

  return { matchId: match.id as string };
}
