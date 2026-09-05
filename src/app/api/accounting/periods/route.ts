import { NextResponse } from "next/server";
import { recordAuditEvent } from "@/lib/accounting/audit";
import {
  booksClosedThrough,
  nextCloseablePeriodEnd,
  recentMonthPeriods,
  validatePeriodClose,
} from "@/lib/accounting/periods";
import { jsonError, requireAdminBooks, requireBooks } from "@/lib/api";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const { data: closes, error } = await supabase
    .from("teller_period_closes")
    .select("id, period_end, notes, closed_at, closed_by")
    .eq("organization_id", organizationId)
    .order("period_end", { ascending: false })
    .limit(24);

  if (error) return jsonError(error.message, 500);

  const closedThrough = booksClosedThrough(closes ?? []);
  const periods = recentMonthPeriods(12, new Date(), closedThrough);
  const nextClose = nextCloseablePeriodEnd(closedThrough);

  return NextResponse.json({
    closedThrough,
    nextClose,
    periods,
    closes: closes ?? [],
  });
}

export async function POST(request: Request) {
  const ctx = await requireAdminBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const body = (await request.json()) as { periodEnd?: string; notes?: string };
  const periodEnd = String(body.periodEnd ?? "").slice(0, 10);
  if (!periodEnd) return jsonError("periodEnd is required");

  const { data: closes, error: readError } = await supabase
    .from("teller_period_closes")
    .select("period_end")
    .eq("organization_id", organizationId);

  if (readError) return jsonError(readError.message, 500);

  const closedThrough = booksClosedThrough(closes ?? []);
  const validation = validatePeriodClose({ periodEnd, closedThrough });
  if (!validation.ok) return jsonError(validation.reason, 400);

  const { data, error } = await supabase
    .from("teller_period_closes")
    .insert({
      organization_id: organizationId,
      period_end: periodEnd,
      notes: String(body.notes ?? "").trim(),
      closed_by: session.userId,
    })
    .select("id, period_end, notes, closed_at, closed_by")
    .single();

  if (error) return jsonError(error.message, 500);

  await recordAuditEvent(supabase, {
    organizationId,
    actorId: session.userId,
    action: "period.closed",
    resourceKind: "accounting_period",
    resourceId: data.id,
    metadata: { periodEnd },
  });

  return NextResponse.json({ close: data, closedThrough: periodEnd });
}

export async function DELETE(request: Request) {
  const ctx = await requireAdminBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const { searchParams } = new URL(request.url);
  const closeId = searchParams.get("id");
  if (!closeId) return jsonError("id is required");

  const { data: target, error: readError } = await supabase
    .from("teller_period_closes")
    .select("id, period_end")
    .eq("organization_id", organizationId)
    .eq("id", closeId)
    .maybeSingle();

  if (readError) return jsonError(readError.message, 500);
  if (!target) return jsonError("Period close not found", 404);

  const { data: latest } = await supabase
    .from("teller_period_closes")
    .select("id, period_end")
    .eq("organization_id", organizationId)
    .order("period_end", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!latest || latest.id !== target.id) {
    return jsonError("Only the most recent period close can be reopened", 400);
  }

  const { error } = await supabase
    .from("teller_period_closes")
    .delete()
    .eq("id", closeId)
    .eq("organization_id", organizationId);

  if (error) return jsonError(error.message, 500);

  await recordAuditEvent(supabase, {
    organizationId,
    actorId: session.userId,
    action: "period.reopened",
    resourceKind: "accounting_period",
    resourceId: closeId,
    metadata: { periodEnd: target.period_end },
  });

  return NextResponse.json({ ok: true });
}
