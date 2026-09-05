import type { SupabaseClient } from "@supabase/supabase-js";

export type AuditAction =
  | "journal.posted"
  | "journal.reversed"
  | "journal.adjustment"
  | "invoice.opened"
  | "invoice.paid"
  | "invoice.partial_payment"
  | "invoice.payment.recorded"
  | "invoice.payment.partial"
  | "invoice.payment.completed"
  | "invoice.voided"
  | "expense.posted"
  | "expense.payment.recorded"
  | "expense.payment.completed"
  | "expense.void"
  | "hfac.webhook.accepted"
  | "hfac.webhook.rejected"
  | "settings.updated"
  | "period.closed"
  | "period.reopened"
  | "data.exported"
  | "intelligence.scanned";

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
