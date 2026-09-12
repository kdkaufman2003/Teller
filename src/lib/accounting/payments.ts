import type { SupabaseClient } from "@supabase/supabase-js";
import { asNumber } from "@/lib/format";
import {
  allocationKindForDocumentKind,
  paymentTypeForDocumentKind,
  recordPaymentAllocation,
  type PaymentType,
} from "./allocations";
import { roundMoney } from "./payment-fees";
import { resolvePostingLegalEntityId } from "./entity-books/document-context";

export type RecordPaymentResult = {
  paymentId: string | null;
  duplicate: boolean;
};

export async function recordTellerPayment(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    legalEntityId?: string | null;
    documentId?: string | null;
    documentKind?: string;
    partyId: string | null;
    jobId: string | null;
    amount: number;
    feeAmount?: number;
    netAmount?: number;
    paymentDate: string;
    processorName?: string;
    paymentMethod?: string;
    referenceNumber?: string;
    externalSource?: string | null;
    externalId?: string | null;
    journalEntryId: string;
    paymentType?: PaymentType;
    metadata?: Record<string, unknown>;
    createAllocation?: boolean;
  },
): Promise<RecordPaymentResult> {
  const amount = roundMoney(asNumber(input.amount));
  const paymentType =
    input.paymentType ??
    (input.documentKind ? paymentTypeForDocumentKind(input.documentKind) : "customer_payment");
  const legalEntityId = await resolvePostingLegalEntityId(supabase, {
    organizationId: input.organizationId,
    documentId: input.documentId,
    legalEntityId: input.legalEntityId,
  });

  const { data, error } = await supabase
    .from("teller_payments")
    .insert({
      organization_id: input.organizationId,
      legal_entity_id: legalEntityId,
      document_id: input.documentId,
      party_id: input.partyId,
      job_id: input.jobId,
      amount,
      fee_amount: roundMoney(asNumber(input.feeAmount)),
      net_amount: input.netAmount == null ? null : roundMoney(asNumber(input.netAmount)),
      payment_date: input.paymentDate,
      processor: input.processorName ?? null,
      payment_method: input.paymentMethod ?? null,
      reference_number: input.referenceNumber ?? null,
      external_source: input.externalSource ?? null,
      external_id: input.externalId ?? null,
      journal_entry_id: input.journalEntryId,
      payment_type: paymentType,
      status: "posted",
      metadata: input.metadata ?? {},
    })
    .select("id")
    .single();

  if (error) {
    if (error.message.includes("duplicate")) {
      if (input.externalSource && input.externalId) {
        const { data: existing } = await supabase
          .from("teller_payments")
          .select("id")
          .eq("organization_id", input.organizationId)
          .eq("external_source", input.externalSource)
          .eq("external_id", input.externalId)
          .maybeSingle();
        return { paymentId: (existing?.id as string) ?? null, duplicate: true };
      }
      if (input.journalEntryId) {
        const { data: existing } = await supabase
          .from("teller_payments")
          .select("id")
          .eq("organization_id", input.organizationId)
          .eq("journal_entry_id", input.journalEntryId)
          .maybeSingle();
        return { paymentId: (existing?.id as string) ?? null, duplicate: true };
      }
      return { paymentId: null, duplicate: true };
    }
    throw new Error(error.message);
  }

  const paymentId = data!.id as string;

  if (input.createAllocation !== false && input.documentId) {
    const allocationKind = allocationKindForDocumentKind(input.documentKind ?? "invoice");
    await recordPaymentAllocation(supabase, {
      organizationId: input.organizationId,
      paymentId,
      documentId: input.documentId,
      amount,
      allocationKind,
    });
  }

  return { paymentId, duplicate: false };
}
