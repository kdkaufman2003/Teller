import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import { roundMoney } from "./payment-fees";

export async function recordTellerPayment(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    documentId: string;
    partyId: string | null;
    jobId: string | null;
    amount: number;
    feeAmount?: number;
    netAmount?: number;
    paymentDate: string;
    processorName?: string;
    externalSource?: string | null;
    externalId?: string | null;
    journalEntryId: string;
    metadata?: Record<string, unknown>;
  },
) {
  const { error } = await supabase.from("teller_payments").insert({
    organization_id: input.organizationId,
    document_id: input.documentId,
    party_id: input.partyId,
    job_id: input.jobId,
    amount: roundMoney(asNumber(input.amount)),
    fee_amount: roundMoney(asNumber(input.feeAmount)),
    net_amount: input.netAmount == null ? null : roundMoney(asNumber(input.netAmount)),
    payment_date: input.paymentDate,
    processor: input.processorName ?? null,
    external_source: input.externalSource ?? null,
    external_id: input.externalId ?? null,
    journal_entry_id: input.journalEntryId,
    metadata: input.metadata ?? {},
  });

  if (error && !error.message.includes("duplicate")) {
    throw new Error(error.message);
  }
}
