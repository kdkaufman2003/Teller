import { NextResponse } from "next/server";
import {
  postAdjustingJournal,
  reverseAdjustingJournal,
} from "@/lib/accounting/adjusting-journals";
import { recordAuditEvent } from "@/lib/accounting/audit";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;
  const { id } = await context.params;

  const { data, error } = await supabase
    .from("teller_adjusting_journal_entries")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();

  if (error) return jsonError(error.message, 500);
  if (!data) return jsonError("Not found", 404);
  return NextResponse.json({ adjustment: data });
}

export async function PATCH(request: Request, context: RouteContext) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;
  const { id } = await context.params;

  const { data: existing } = await supabase
    .from("teller_adjusting_journal_entries")
    .select("status")
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();
  if (!existing) return jsonError("Not found", 404);
  if (existing.status !== "draft") return jsonError("Only draft adjustments can be edited", 400);

  const body = (await request.json()) as {
    memo?: string;
    reference?: string;
    entryDate?: string;
    lines?: unknown;
  };

  const { data, error } = await supabase
    .from("teller_adjusting_journal_entries")
    .update({
      ...(body.memo !== undefined ? { memo: body.memo } : {}),
      ...(body.reference !== undefined ? { reference: body.reference } : {}),
      ...(body.entryDate !== undefined ? { entry_date: body.entryDate.slice(0, 10) } : {}),
      ...(body.lines !== undefined ? { lines: body.lines } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("*")
    .single();

  if (error) return jsonError(error.message, 500);

  await recordAuditEvent(supabase, {
    organizationId,
    actorId: session.userId,
    action: "adjustment.updated",
    resourceKind: "adjusting_journal",
    resourceId: id,
  });

  return NextResponse.json({ adjustment: data });
}

export async function POST(request: Request, context: RouteContext) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;
  const { id } = await context.params;

  const body = (await request.json()) as { action?: string; reversalDate?: string; reason?: string };
  const action = body.action ?? "post";

  try {
    if (action === "post") {
      const result = await postAdjustingJournal(supabase, {
        organizationId,
        adjustmentId: id,
        actorId: session.userId,
        approvalRequired: false,
      });
      return NextResponse.json(result);
    }
    if (action === "submit") {
      const { data, error } = await supabase
        .from("teller_adjusting_journal_entries")
        .update({
          status: "submitted",
          submitted_at: new Date().toISOString(),
          submitted_by: session.userId,
        })
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      await recordAuditEvent(supabase, {
        organizationId,
        actorId: session.userId,
        action: "adjustment.submitted",
        resourceKind: "adjusting_journal",
        resourceId: id,
      });
      return NextResponse.json({ adjustment: data });
    }
    if (action === "approve") {
      const { data, error } = await supabase
        .from("teller_adjusting_journal_entries")
        .update({
          status: "approved",
          approved_at: new Date().toISOString(),
          approved_by: session.userId,
        })
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      await recordAuditEvent(supabase, {
        organizationId,
        actorId: session.userId,
        action: "adjustment.approved",
        resourceKind: "adjusting_journal",
        resourceId: id,
      });
      return NextResponse.json({ adjustment: data });
    }
    if (action === "reverse") {
      if (!body.reversalDate || !body.reason?.trim()) {
        return jsonError("reversalDate and reason are required", 400);
      }
      const result = await reverseAdjustingJournal(supabase, {
        organizationId,
        adjustmentId: id,
        reversalDate: body.reversalDate,
        reason: body.reason,
        actorId: session.userId,
      });
      return NextResponse.json(result);
    }
    return jsonError(`Unknown action: ${action}`, 400);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Action failed", 400);
  }
}
