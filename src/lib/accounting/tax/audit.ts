import type { SupabaseClient } from "@supabase/supabase-js";

export const TAX_AUDIT_EVENT_TYPES = [
  "tax_settings_updated",
  "tax_registration_created",
  "tax_registration_updated",
  "tax_rate_created",
  "tax_rate_changed",
  "taxability_rule_created",
  "taxability_rule_changed",
  "tax_exemption_created",
  "tax_exemption_changed",
  "tax_filing_period_status_changed",
  "manual_tax_adjustment",
] as const;

export type TaxAuditEventType = (typeof TAX_AUDIT_EVENT_TYPES)[number];

export type TaxAuditEventInput = {
  organizationId: string;
  eventType: TaxAuditEventType;
  entityType: string;
  entityId?: string | null;
  payload?: Record<string, unknown>;
  createdBy?: string | null;
};

export async function recordTaxAuditEvent(
  supabase: SupabaseClient,
  input: TaxAuditEventInput,
): Promise<void> {
  const { error } = await supabase.from("teller_tax_audit_events").insert({
    organization_id: input.organizationId,
    event_type: input.eventType,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    payload: input.payload ?? {},
    created_by: input.createdBy ?? null,
  });
  if (error) throw new Error(error.message);
}
