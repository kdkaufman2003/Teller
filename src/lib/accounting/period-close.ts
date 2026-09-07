import type { SupabaseClient } from "@supabase/supabase-js";
import { recordAuditEvent } from "./audit";
import {
  AccountingStateChangedError,
  loadAccountingStateVersions,
} from "./accounting-state";
import { evaluateCloseReadiness } from "./close-readiness";
import { buildTrialBalance } from "./trial-balance";

export async function closeAccountingPeriod(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    periodEnd: string;
    notes?: string;
    warningsAcknowledged?: unknown[];
    actorId?: string | null;
    skipReadiness?: boolean;
    expectedAccountingVersion?: number;
    expectedCloseStateVersion?: number;
  },
) {
  const periodEnd = input.periodEnd.slice(0, 10);

  const readiness = await evaluateCloseReadiness(supabase, input.organizationId, periodEnd);
  if (!input.skipReadiness && !readiness.ready) {
    throw new Error(`Period not ready to close: ${readiness.blockerCount} blocker(s)`);
  }

  const expectedAccountingVersion =
    input.expectedAccountingVersion ?? readiness.accountingVersion;
  const expectedCloseStateVersion =
    input.expectedCloseStateVersion ?? readiness.closeStateVersion;

  const tb = await buildTrialBalance(supabase, input.organizationId, {
    periodStart: periodEnd.slice(0, 8) + "01",
    periodEnd,
  });

  const snapshot = {
    readiness,
    trialBalanceTotals: tb.totals,
    trialBalanceHash: `${tb.totals.adjustedDebit}:${tb.totals.adjustedCredit}`,
    accountingVersion: expectedAccountingVersion,
    closeStateVersion: expectedCloseStateVersion,
    closedAt: new Date().toISOString(),
  };

  const { data: eventId, error } = await supabase.rpc("teller_close_accounting_period", {
    p_organization_id: input.organizationId,
    p_period_end: periodEnd,
    p_notes: input.notes ?? "",
    p_readiness_snapshot: snapshot,
    p_warnings_acknowledged: input.warningsAcknowledged ?? [],
    p_actor_id: input.actorId ?? null,
    p_expected_accounting_version: expectedAccountingVersion,
    p_expected_close_state_version: expectedCloseStateVersion,
  });

  if (error) {
    if (error.message.includes("ACCOUNTING_STATE_CHANGED")) {
      throw new AccountingStateChangedError();
    }
    throw new Error(error.message);
  }

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "period.closed",
    resourceKind: "accounting_period",
    resourceId: eventId as string,
    metadata: { periodEnd, snapshot },
  });

  return { eventId: eventId as string, periodEnd, snapshot };
}

export async function reopenAccountingPeriod(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    periodEnd: string;
    reason: string;
    actorId?: string | null;
  },
) {
  const periodEnd = input.periodEnd.slice(0, 10);
  if (!input.reason.trim()) throw new Error("Reopen reason is required");

  const { data: eventId, error } = await supabase.rpc("teller_reopen_accounting_period", {
    p_organization_id: input.organizationId,
    p_period_end: periodEnd,
    p_reason: input.reason.trim(),
    p_actor_id: input.actorId ?? null,
  });
  if (error) throw new Error(error.message);

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "period.reopened",
    resourceKind: "accounting_period",
    resourceId: eventId as string,
    metadata: { periodEnd, reason: input.reason.trim() },
  });

  return { eventId: eventId as string, periodEnd };
}

export async function startPeriodReview(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    periodEnd: string;
    actorId?: string | null;
  },
) {
  const periodEnd = input.periodEnd.slice(0, 10);
  const readiness = await evaluateCloseReadiness(supabase, input.organizationId, periodEnd);

  const { data, error } = await supabase
    .from("teller_period_close_reviews")
    .upsert(
      {
        organization_id: input.organizationId,
        period_end: periodEnd,
        status: "in_review",
        started_at: new Date().toISOString(),
        started_by: input.actorId ?? null,
        readiness_snapshot: readiness,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,period_end" },
    )
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "Could not start review");

  await recordAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "period.review_started",
    resourceKind: "period_close_review",
    resourceId: data.id as string,
    metadata: { periodEnd },
  });

  return data;
}
