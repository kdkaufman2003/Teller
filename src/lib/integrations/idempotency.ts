import type { SupabaseClient } from "@supabase/supabase-js";
import { HFAC_EXTERNAL_SOURCE } from "./constants";

export type IntegrationEventKind = "payment" | "quote" | "billing" | "subscriber";

type PaymentIdempotencyInput = {
  stripePaymentIntentId?: string;
  stripeInvoiceId?: string;
  hfacDealId?: string;
  paidAt: string;
  amount: number;
};

export function paymentIdempotencyKey(payment: PaymentIdempotencyInput): string | null {
  if (payment.stripePaymentIntentId?.trim()) {
    return `stripe:pi:${payment.stripePaymentIntentId.trim()}`;
  }
  if (payment.stripeInvoiceId?.trim()) {
    return `stripe:in:${payment.stripeInvoiceId.trim()}:${payment.paidAt.slice(0, 10)}`;
  }
  if (payment.hfacDealId?.trim()) {
    return `hfac:deal:${payment.hfacDealId.trim()}:${payment.paidAt}:${payment.amount}`;
  }
  return null;
}

export function quoteIdempotencyKey(source: string, quoteId: string): string {
  return `hfac:quote:${source}:${quoteId}`;
}

/** Returns true when this event was already processed. */
export async function integrationEventSeen(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    provider?: string;
    eventKind: IntegrationEventKind;
    idempotencyKey: string;
  },
): Promise<boolean> {
  const provider = input.provider ?? HFAC_EXTERNAL_SOURCE;
  const { data } = await supabase
    .from("teller_integration_events")
    .select("id")
    .eq("organization_id", input.organizationId)
    .eq("provider", provider)
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();
  return Boolean(data?.id);
}

export async function recordIntegrationEvent(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    provider?: string;
    eventKind: IntegrationEventKind;
    idempotencyKey: string;
    result: Record<string, unknown>;
  },
) {
  const provider = input.provider ?? HFAC_EXTERNAL_SOURCE;
  const { error } = await supabase.from("teller_integration_events").insert({
    organization_id: input.organizationId,
    provider,
    event_kind: input.eventKind,
    idempotency_key: input.idempotencyKey,
    result: input.result,
  });

  if (error && !error.message.includes("duplicate")) {
    throw new Error(error.message);
  }
}
