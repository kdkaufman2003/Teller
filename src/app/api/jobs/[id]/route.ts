import { NextResponse } from "next/server";
import {
  buildJobProfitabilitySummary,
} from "@/lib/accounting/job-profitability";
import {
  cancelJob,
  closeJob,
  detectJobCloseWarnings,
  markJobCompleted,
  reopenJob,
  updateJob,
} from "@/lib/accounting/jobs";
import { asNumber } from "@/lib/format";
import { canCloseJobs, canReopenJobs } from "@/lib/auth/roles";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;
  const { id } = await context.params;

  const { data: job, error } = await supabase
    .from("teller_jobs")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();
  if (error) return jsonError(error.message, 500);
  if (!job) return jsonError("Job not found", 404);

  const profitability = await buildJobProfitabilitySummary(supabase, organizationId, id);
  return NextResponse.json({ job, profitability });
}

export async function PATCH(request: Request, context: RouteContext) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;
  const { id } = await context.params;
  const body = (await request.json()) as {
    action?: "update" | "complete" | "close" | "reopen" | "cancel";
    name?: string;
    description?: string;
    jobType?: string;
    status?: string;
    estimatedRevenue?: number;
    estimatedCost?: number;
    revisedContractAmount?: number;
    overrideReason?: string;
    reason?: string;
  };

  if (body.action === "complete") {
    await markJobCompleted(supabase, {
      organizationId,
      jobId: id,
      actorId: session.userId,
    });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "close") {
    if (!canCloseJobs(session.profile?.role)) {
      return jsonError("Only owners and admins can close jobs", 403);
    }
    const warnings = await detectJobCloseWarnings(supabase, organizationId, id);
    await closeJob(supabase, {
      organizationId,
      jobId: id,
      overrideReason: body.overrideReason,
      actorId: session.userId,
    });
    return NextResponse.json({ ok: true, warnings });
  }

  if (body.action === "reopen") {
    if (!canReopenJobs(session.profile?.role)) {
      return jsonError("Only owners and admins can reopen jobs", 403);
    }
    if (!body.reason?.trim()) return jsonError("Reopen reason is required", 400);
    await reopenJob(supabase, {
      organizationId,
      jobId: id,
      reason: body.reason,
      actorId: session.userId,
    });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "cancel") {
    await cancelJob(supabase, {
      organizationId,
      jobId: id,
      actorId: session.userId,
    });
    return NextResponse.json({ ok: true });
  }

  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch.name = body.name.trim();
  if (body.description !== undefined) patch.description = body.description.trim();
  if (body.jobType !== undefined) patch.job_type = body.jobType;
  if (body.estimatedRevenue !== undefined) patch.estimated_revenue = asNumber(body.estimatedRevenue);
  if (body.estimatedCost !== undefined) patch.estimated_cost = asNumber(body.estimatedCost);
  if (body.revisedContractAmount !== undefined) {
    patch.revised_contract_amount = asNumber(body.revisedContractAmount);
  }

  if (Object.keys(patch).length) {
    await updateJob(supabase, {
      organizationId,
      jobId: id,
      patch,
      actorId: session.userId,
    });
  }

  return NextResponse.json({ ok: true });
}
