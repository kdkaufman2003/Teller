import { NextResponse } from "next/server";
import { evaluateCloseReadiness } from "@/lib/accounting/close-readiness";
import { jsonError, requireBooks } from "@/lib/api";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const { searchParams } = new URL(request.url);
  const periodEnd = String(searchParams.get("periodEnd") ?? "").slice(0, 10);
  if (!periodEnd) return jsonError("periodEnd is required", 400);

  const report = await evaluateCloseReadiness(supabase, organizationId, periodEnd);
  return NextResponse.json(report);
}
