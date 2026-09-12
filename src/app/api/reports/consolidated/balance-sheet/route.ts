import { NextResponse } from "next/server";
import {
  buildConsolidatedBalanceSheet,
  parseConsolidationRequestParams,
} from "@/lib/accounting/consolidated";
import { jsonError, requireAccountingBooks } from "@/lib/api";
import { parseFiscalYearStart } from "@/lib/org/config";
import { getSessionContext } from "@/lib/session";

export async function GET(request: Request) {
  const ctx = await requireAccountingBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const session = await getSessionContext();
  const fiscalYearStart = parseFiscalYearStart(session?.settings?.answers?.fiscalYearStart);

  const url = new URL(request.url);
  const params = parseConsolidationRequestParams(url);
  const asOf = params.asOf ?? params.periodEnd ?? new Date().toISOString().slice(0, 10);

  try {
    const report = await buildConsolidatedBalanceSheet(ctx.supabase, {
      organizationId: ctx.organizationId,
      legalEntityIds: params.legalEntityIds,
      includeAllEntities: params.includeAllEntities,
      asOf,
      fiscalYearStartMonth: fiscalYearStart,
      auth: ctx.auth,
    });
    return NextResponse.json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Consolidated balance sheet failed";
    const status = /access|permission/i.test(message) ? 403 : 400;
    return jsonError(message, status);
  }
}
