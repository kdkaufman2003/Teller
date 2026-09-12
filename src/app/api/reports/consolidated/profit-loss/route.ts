import { NextResponse } from "next/server";
import {
  buildConsolidatedProfitAndLoss,
  parseConsolidationRequestParams,
} from "@/lib/accounting/consolidated";
import { jsonError, requireAccountingBooks } from "@/lib/api";

export async function GET(request: Request) {
  const ctx = await requireAccountingBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const url = new URL(request.url);
  const params = parseConsolidationRequestParams(url);
  const periodEnd = params.periodEnd ?? new Date().toISOString().slice(0, 10);

  try {
    const report = await buildConsolidatedProfitAndLoss(ctx.supabase, {
      organizationId: ctx.organizationId,
      legalEntityIds: params.legalEntityIds,
      includeAllEntities: params.includeAllEntities,
      periodStart: params.periodStart,
      periodEnd,
      auth: ctx.auth,
    });
    return NextResponse.json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Consolidated P&L failed";
    const status = /access|permission/i.test(message) ? 403 : 400;
    return jsonError(message, status);
  }
}
