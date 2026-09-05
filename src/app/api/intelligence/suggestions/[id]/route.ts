import { NextResponse } from "next/server";
import { jsonError, requireWriteBooks } from "@/lib/api";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function PATCH(request: Request, { params }: RouteContext) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;
  const { id } = await params;

  const body = (await request.json()) as { status?: "accepted" | "dismissed" };
  if (body.status !== "accepted" && body.status !== "dismissed") {
    return jsonError("status must be accepted or dismissed");
  }

  const { data, error } = await supabase
    .from("teller_intelligence_suggestions")
    .update({
      status: body.status,
      resolved_at: new Date().toISOString(),
      resolved_by: session.userId,
    })
    .eq("organization_id", organizationId)
    .eq("id", id)
    .eq("status", "pending")
    .select("id, status")
    .maybeSingle();

  if (error) return jsonError(error.message, 500);
  if (!data) return jsonError("Suggestion not found or already resolved", 404);

  return NextResponse.json({ suggestion: data });
}
