import { NextResponse } from "next/server";
import { buildConsolidationEliminationSuggestions } from "@/lib/accounting/consolidated/eliminations";
import { parseConsolidationRequestParams } from "@/lib/accounting/consolidated";
import { jsonError, requireAccountingBooks } from "@/lib/api";

export async function GET(request: Request) {
  const ctx = await requireAccountingBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const url = new URL(request.url);
  const params = parseConsolidationRequestParams(url);
  const asOf = params.asOf ?? params.periodEnd ?? new Date().toISOString().slice(0, 10);

  try {
    const suggestions = await buildConsolidationEliminationSuggestions(ctx.supabase, {
      organizationId: ctx.organizationId,
      legalEntityIds: params.legalEntityIds,
      includeAllEntities: params.includeAllEntities,
      asOf,
      periodStart: params.periodStart,
      periodEnd: params.periodEnd ?? asOf,
      auth: ctx.auth,
    });
    return NextResponse.json(suggestions);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not build elimination suggestions";
    const status = /access|permission/i.test(message) ? 403 : 400;
    return jsonError(message, status);
  }
}
