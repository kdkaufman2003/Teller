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
  | "invoice.void_blocked"
  | "invoice.refunded"
  | "invoice.writeoff"
  | "payment.reversed"
  | "payment.recorded"
  | "payment.allocated"
  | "document.status_changed"
  | "subledger.integrity_checked"
  | "expense.posted"
  | "expense.payment.recorded"
  | "expense.payment.completed"
  | "expense.void"
  | "bill.created"
  | "bill.posted"
  | "bill.payment.recorded"
  | "bill.partially_paid"
  | "bill.paid"
  | "bill.voided"
  | "vendor.created"
  | "vendor.updated"
  | "purchase_order.created"
  | "purchase_order.submitted"
  | "purchase_order.approved"
  | "purchase_order.rejected"
  | "purchase_order.received"
  | "purchase_order.billed"
  | "credit_memo.created"
  | "credit_memo.posted"
  | "credit_memo.applied"
  | "credit_memo.voided"
  | "credit_memo.refunded"
  | "credit.application_reversed"
  | "vendor_credit.created"
  | "vendor_credit.posted"
  | "vendor_credit.applied"
  | "vendor_credit.voided"
  | "document_credit_allocation.created"
  | "deposit.received"
  | "deposit.applied"
  | "deposit.partially_applied"
  | "deposit.fully_applied"
  | "deposit.void_blocked"
  | "deposit.reversed"
  | "deposit.refunded"
  | "deposit.application_reversed"
  | "unapplied_payment.recorded"
  | "hfac.webhook.accepted"
  | "hfac.webhook.rejected"
  | "settings.updated"
  | "period.closed"
  | "period.reopened"
  | "data.exported"
  | "intelligence.scanned"
  | "job.created"
  | "job.updated"
  | "job.completed"
  | "job.closed"
  | "job.reopened"
  | "job.cancelled"
  | "job.budget_updated"
  | "fixed_asset.created"
  | "fixed_asset.updated"
  | "fixed_asset.linked"
  | "fixed_asset.activated"
  | "fixed_asset.capitalized"
  | "fixed_asset.opening_recorded"
  | "fixed_asset.depreciation_posted"
  | "fixed_asset.depreciation_reversed"
  | "fixed_asset.disposed"
  | "fixed_asset.sold"
  | "fixed_asset.written_off"
  | "fixed_asset.disposal_reversed"
  | "fixed_asset.category_created";

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
