import { NextResponse } from "next/server";
import { buildConsolidationWorksheet } from "@/lib/accounting/consolidated/eliminations";
import { parseConsolidationRequestParams } from "@/lib/accounting/consolidated";
import { jsonError, requireAccountingBooks } from "@/lib/api";

export async function GET(request: Request) {
  const ctx = await requireAccountingBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const url = new URL(request.url);
  const params = parseConsolidationRequestParams(url);
  const periodEnd = params.periodEnd ?? params.asOf ?? new Date().toISOString().slice(0, 10);

  try {
    const worksheet = await buildConsolidationWorksheet(ctx.supabase, {
      organizationId: ctx.organizationId,
      legalEntityIds: params.legalEntityIds,
      includeAllEntities: params.includeAllEntities,
      periodStart: params.periodStart,
      periodEnd,
      auth: ctx.auth,
    });
    return NextResponse.json(worksheet);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not build consolidation worksheet";
    const status = /access|permission/i.test(message) ? 403 : 400;
    return jsonError(message, status);
  }
}
