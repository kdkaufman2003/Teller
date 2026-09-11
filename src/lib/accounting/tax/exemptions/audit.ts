import type { SupabaseClient } from "@supabase/supabase-js";
import type { TaxAuditEventType } from "../audit";

export async function recordTaxExemptionAuditEvent(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    eventType: TaxAuditEventType;
    entityId: string;
    payload?: Record<string, unknown>;
    createdBy?: string | null;
  },
): Promise<void> {
  const { error } = await supabase.from("teller_tax_audit_events").insert({
    organization_id: input.organizationId,
    event_type: input.eventType,
    entity_type: "tax_exemption",
    entity_id: input.entityId,
    payload: input.payload ?? {},
    created_by: input.createdBy ?? null,
  });
  if (error) throw new Error(error.message);
}
