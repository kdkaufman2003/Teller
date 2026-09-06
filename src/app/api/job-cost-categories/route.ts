import { NextResponse } from "next/server";
import { seedHvacJobCostCategories } from "@/lib/accounting/job-cost-categories";
import { recordAuditEvent } from "@/lib/accounting/audit";
import { asNumber } from "@/lib/format";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const { data, error } = await supabase
    .from("teller_job_cost_categories")
    .select("*")
    .eq("organization_id", organizationId)
    .order("sort_order", { ascending: true });
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ categories: data ?? [] });
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;
  const body = (await request.json()) as {
    action?: "seed_hvac_defaults" | "create";
    code?: string;
    name?: string;
    categoryType?: string;
    description?: string;
  };

  if (body.action === "seed_hvac_defaults") {
    await seedHvacJobCostCategories(supabase, organizationId);
    return NextResponse.json({ ok: true });
  }

  if (!body.code?.trim() || !body.name?.trim()) {
    return jsonError("Code and name are required");
  }

  const { data, error } = await supabase
    .from("teller_job_cost_categories")
    .insert({
      organization_id: organizationId,
      code: body.code.trim(),
      name: body.name.trim(),
      description: body.description?.trim() || "",
      category_type: body.categoryType || "other",
    })
    .select("*")
    .single();
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ category: data });
}
