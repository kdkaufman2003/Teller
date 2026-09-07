import { NextResponse } from "next/server";
import { buildFixedAssetReconciliationReport } from "@/lib/accounting/fixed-asset-reconciliation";
import { jsonError, requireBooks } from "@/lib/api";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const url = new URL(request.url);
  const asOfDate = url.searchParams.get("asOfDate");
  const periodYear = url.searchParams.get("periodYear");
  const periodMonth = url.searchParams.get("periodMonth");

  const report = await buildFixedAssetReconciliationReport(ctx.supabase, ctx.organizationId, {
    asOfDate,
    periodYear: periodYear ? Number(periodYear) : undefined,
    periodMonth: periodMonth ? Number(periodMonth) : undefined,
  });

  return NextResponse.json(report);
}
