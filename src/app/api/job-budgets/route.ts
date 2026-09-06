import { NextResponse } from "next/server";
import { recordAuditEvent } from "@/lib/accounting/audit";
import { asNumber } from "@/lib/format";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;
  const jobId = new URL(request.url).searchParams.get("jobId");
  if (!jobId) return jsonError("jobId is required");

  const { data, error } = await supabase
    .from("teller_job_budget_lines")
    .select("*, teller_job_cost_categories(code, name)")
    .eq("organization_id", organizationId)
    .eq("job_id", jobId)
    .order("created_at", { ascending: true });
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ budgetLines: data ?? [] });
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;
  const body = (await request.json()) as {
    jobId?: string;
    costCategoryId?: string;
    costClassification?: string;
    estimatedQuantity?: number;
    estimatedUnitCost?: number;
    estimatedAmount?: number;
    notes?: string;
  };

  if (!body.jobId) return jsonError("jobId is required");

  const amount =
    body.estimatedAmount != null
      ? asNumber(body.estimatedAmount)
      : asNumber(body.estimatedQuantity) * asNumber(body.estimatedUnitCost);

  const { data, error } = await supabase
    .from("teller_job_budget_lines")
    .insert({
      organization_id: organizationId,
      job_id: body.jobId,
      cost_category_id: body.costCategoryId || null,
      cost_classification: body.costClassification || "direct",
      estimated_quantity: body.estimatedQuantity ?? null,
      estimated_unit_cost: body.estimatedUnitCost ?? null,
      estimated_amount: amount,
      notes: body.notes?.trim() || "",
    })
    .select("*")
    .single();
  if (error) return jsonError(error.message, 500);

  await recordAuditEvent(supabase, {
    organizationId,
    actorId: session.userId,
    action: "job.budget_updated",
    resourceKind: "job_budget_line",
    resourceId: data.id as string,
    metadata: { jobId: body.jobId, amount },
  });

  return NextResponse.json({ budgetLine: data });
}
