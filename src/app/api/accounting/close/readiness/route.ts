import { NextResponse } from "next/server";
import { evaluateCloseReadiness } from "@/lib/accounting/close-readiness";
import { jsonError, requireAccountingBooks } from "@/lib/api";

export async function GET(request: Request) {
  const ctx = await requireAccountingBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, legalEntityId } = ctx;

  const { searchParams } = new URL(request.url);
  const periodEnd = String(searchParams.get("periodEnd") ?? "").slice(0, 10);
  if (!periodEnd) return jsonError("periodEnd is required", 400);

  const report = await evaluateCloseReadiness(supabase, organizationId, legalEntityId, periodEnd);
  return NextResponse.json(report);
}
