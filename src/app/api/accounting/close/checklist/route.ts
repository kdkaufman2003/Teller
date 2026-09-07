import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const { searchParams } = new URL(request.url);
  const periodEnd = String(searchParams.get("periodEnd") ?? "").slice(0, 10);
  if (!periodEnd) return jsonError("periodEnd is required", 400);

  const { data, error } = await supabase
    .from("teller_close_checklist_items")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("period_end", periodEnd)
    .order("sort_order");

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ items: data ?? [] });
}

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const body = (await request.json()) as {
    periodEnd?: string;
    itemKey?: string;
    title?: string;
    description?: string;
    required?: boolean;
    complete?: boolean;
  };

  const periodEnd = String(body.periodEnd ?? "").slice(0, 10);
  const itemKey = String(body.itemKey ?? "").trim();
  if (!periodEnd || !itemKey) return jsonError("periodEnd and itemKey are required", 400);

  const { data, error } = await supabase
    .from("teller_close_checklist_items")
    .upsert(
      {
        organization_id: organizationId,
        period_end: periodEnd,
        item_key: itemKey,
        title: body.title ?? itemKey,
        description: body.description ?? "",
        source: "custom",
        required: Boolean(body.required),
        status: body.complete ? "completed" : "pending",
        completed_at: body.complete ? new Date().toISOString() : null,
        completed_by: body.complete ? session.userId : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,period_end,item_key" },
    )
    .select("*")
    .single();

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ item: data });
}
