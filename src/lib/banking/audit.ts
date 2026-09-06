import type { SupabaseClient } from "@supabase/supabase-js";
import { recordAuditEvent, type AuditAction } from "@/lib/accounting/audit";

export type BankingAuditAction =
  | "banking.connection.created"
  | "banking.connection.disconnected"
  | "banking.sync.started"
  | "banking.sync.completed"
  | "banking.sync.failed"
  | "banking.transaction.imported"
  | "banking.transaction.superseded"
  | "banking.transaction.provider_removed"
  | "banking.csv_batch.imported"
  | "banking.match.suggested"
  | "banking.match.confirmed"
  | "banking.match.removed"
  | "banking.transaction.categorized"
  | "banking.transaction.split_categorized"
  | "banking.transfer.created"
  | "banking.transaction.excluded"
  | "banking.reconciliation.started"
  | "banking.reconciliation.finalized"
  | "banking.reconciliation.reopened";

const BANKING_AUDIT_MAP: Record<BankingAuditAction, AuditAction> = {
  "banking.connection.created": "settings.updated",
  "banking.connection.disconnected": "settings.updated",
  "banking.sync.started": "settings.updated",
  "banking.sync.completed": "settings.updated",
  "banking.sync.failed": "settings.updated",
  "banking.transaction.imported": "settings.updated",
  "banking.transaction.superseded": "settings.updated",
  "banking.transaction.provider_removed": "settings.updated",
  "banking.csv_batch.imported": "settings.updated",
  "banking.match.suggested": "settings.updated",
  "banking.match.confirmed": "payment.allocated",
  "banking.match.removed": "payment.reversed",
  "banking.transaction.categorized": "expense.posted",
  "banking.transaction.split_categorized": "expense.posted",
  "banking.transfer.created": "journal.posted",
  "banking.transaction.excluded": "document.status_changed",
  "banking.reconciliation.started": "settings.updated",
  "banking.reconciliation.finalized": "period.closed",
  "banking.reconciliation.reopened": "period.reopened",
};

export async function recordBankingAuditEvent(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    actorId?: string | null;
    action: BankingAuditAction;
    resourceKind: string;
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: BANKING_AUDIT_MAP[input.action],
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
    metadata: {
      bankingAction: input.action,
      ...(input.metadata ?? {}),
    },
  });
}
