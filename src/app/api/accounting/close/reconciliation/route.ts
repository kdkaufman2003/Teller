import { NextResponse } from "next/server";
import { buildCloseReconciliationSummary } from "@/lib/accounting/close-reconciliation-summary";
import { jsonError, requireBooks } from "@/lib/api";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId } = ctx;

  const { searchParams } = new URL(request.url);
  const asOfDate = String(searchParams.get("asOfDate") ?? searchParams.get("periodEnd") ?? "").slice(0, 10);
  if (!asOfDate) return jsonError("asOfDate or periodEnd is required", 400);

  const items = await buildCloseReconciliationSummary(supabase, organizationId, { asOfDate });
  return NextResponse.json({ items });
}
