import { NextResponse } from "next/server";
import { closeAccountingPeriod, reopenAccountingPeriod } from "@/lib/accounting/period-close";
import { recordAuditEvent } from "@/lib/accounting/audit";
import {
  booksClosedThrough,
  nextCloseablePeriodEnd,
  recentMonthPeriods,
} from "@/lib/accounting/periods";
import { resolveLegalEntityId } from "@/lib/accounting/post";
import { jsonError, requireAccountingAdminBooks, requireAccountingBooks } from "@/lib/api";

export async function GET() {
  const ctx = await requireAccountingBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, legalEntityId } = ctx;
  const entityId =
    legalEntityId ?? (await resolveLegalEntityId(supabase, organizationId, null));

  const { data: closes, error } = await supabase
    .from("teller_period_closes")
    .select(
      "id, period_end, notes, closed_at, closed_by, event_type, effective_closed_through, reopen_reason, readiness_snapshot, warnings_acknowledged, legal_entity_id",
    )
    .eq("organization_id", organizationId)
    .eq("legal_entity_id", entityId)
    .order("closed_at", { ascending: false })
    .limit(48);

  if (error) return jsonError(error.message, 500);

  const closedThrough = booksClosedThrough(closes ?? []);
  const periods = recentMonthPeriods(12, new Date(), closedThrough);
  const nextClose = nextCloseablePeriodEnd(closedThrough);

  return NextResponse.json({
    closedThrough,
    nextClose,
    periods,
    closes: closes ?? [],
    events: closes ?? [],
  });
}

/** Legacy close endpoint — prefer POST /api/accounting/periods/close */
export async function POST(request: Request) {
  const ctx = await requireAccountingAdminBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, legalEntityId, session } = ctx;

  const body = (await request.json()) as { periodEnd?: string; notes?: string };
  const periodEnd = String(body.periodEnd ?? "").slice(0, 10);
  if (!periodEnd) return jsonError("periodEnd is required", 400);

  try {
    const result = await closeAccountingPeriod(supabase, {
      organizationId,
      legalEntityId,
      periodEnd,
      notes: body.notes,
      actorId: session.userId,
    });
    return NextResponse.json({ close: { id: result.eventId, period_end: periodEnd }, ...result });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Could not close period", 400);
  }
}

/**
 * Legacy reopen endpoint used by deployed Phase 8 UI (commit 8bbd89b).
 * Translates DELETE into immutable reopen-event semantics via RPC.
 * DB trigger also converts direct DELETE for old app during migration window.
 */
export async function DELETE(request: Request) {
  const ctx = await requireAccountingAdminBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, legalEntityId, session } = ctx;
  const entityId =
    legalEntityId ?? (await resolveLegalEntityId(supabase, organizationId, null));

  const { searchParams } = new URL(request.url);
  const closeId = searchParams.get("id");
  if (!closeId) return jsonError("id is required", 400);

  const { data: target, error: readError } = await supabase
    .from("teller_period_closes")
    .select("id, period_end, event_type")
    .eq("organization_id", organizationId)
    .eq("legal_entity_id", entityId)
    .eq("id", closeId)
    .maybeSingle();

  if (readError) return jsonError(readError.message, 500);
  if (!target) return jsonError("Period close not found", 404);
  if (target.event_type === "reopen") {
    return jsonError("Cannot reopen a reopen history event", 400);
  }

  const { data: events, error: eventsError } = await supabase
    .from("teller_period_closes")
    .select("period_end, effective_closed_through, closed_at, event_type")
    .eq("organization_id", organizationId)
    .eq("legal_entity_id", entityId);

  if (eventsError) return jsonError(eventsError.message, 500);

  const closedThrough = booksClosedThrough(events ?? []);
  if (!closedThrough || target.period_end !== closedThrough) {
    return jsonError("Only the most recent period close can be reopened", 400);
  }

  try {
    const result = await reopenAccountingPeriod(supabase, {
      organizationId,
      legalEntityId: entityId,
      periodEnd: target.period_end as string,
      reason: "Legacy API reopen",
      actorId: session.userId,
    });

    await recordAuditEvent(supabase, {
      organizationId,
      actorId: session.userId,
      action: "period.reopened",
      resourceKind: "accounting_period",
      resourceId: closeId,
      metadata: { periodEnd: target.period_end, legacyDelete: true },
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Could not reopen period", 400);
  }
}
