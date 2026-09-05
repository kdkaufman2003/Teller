import type { SupabaseClient } from "@supabase/supabase-js";

export type AuditAction =
  | "journal.posted"
  | "journal.reversed"
  | "journal.adjustment"
  | "invoice.opened"
  | "invoice.paid"
  | "invoice.partial_payment"
  | "invoice.voided"
  | "expense.posted"
  | "settings.updated"
  | "period.closed"
  | "period.reopened"
  | "data.exported";

export async function recordAuditEvent(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    actorId?: string | null;
    action: AuditAction;
    resourceKind: string;
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  const { error } = await supabase.from("teller_audit_events").insert({
    organization_id: input.organizationId,
    actor_id: input.actorId ?? null,
    action: input.action,
    resource_kind: input.resourceKind,
    resource_id: input.resourceId ?? null,
    metadata: input.metadata ?? {},
  });

  if (error) {
    console.warn("Audit event not recorded:", error.message);
  }
}
