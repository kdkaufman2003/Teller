import { NextResponse } from "next/server";
import {
  createConsolidationElimination,
  listConsolidationEliminations,
} from "@/lib/accounting/consolidated/eliminations";
import { parseConsolidationRequestParams } from "@/lib/accounting/consolidated";
import { jsonError, requireAccountingAdminBooks, requireAccountingBooks } from "@/lib/api";

export async function GET(request: Request) {
  const ctx = await requireAccountingBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const params = parseConsolidationRequestParams(url);

  try {
    const scope = await listConsolidationEliminations(ctx.supabase, {
      organizationId: ctx.organizationId,
      status: status as import("@/lib/accounting/consolidated/eliminations/types").EliminationStatus | null,
      auth: ctx.auth,
    });
    void params;
    return NextResponse.json({ entries: scope });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not list eliminations";
    return jsonError(message, 400);
  }
}

export async function POST(request: Request) {
  const ctx = await requireAccountingAdminBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const body = (await request.json()) as {
    legalEntityIds?: string[];
    includeAllEntities?: boolean;
    effectiveDate: string;
    periodStart?: string | null;
    periodEnd?: string | null;
    entryType: import("@/lib/accounting/consolidated/eliminations/types").EliminationEntryType;
    sourceKind?: import("@/lib/accounting/consolidated/eliminations/types").EliminationSourceKind;
    status?: import("@/lib/accounting/consolidated/eliminations/types").EliminationStatus;
    description: string;
    memo?: string;
    lines: import("@/lib/accounting/consolidated/eliminations/types").EliminationLineInput[];
    sources?: Array<{
      sourceKind: string;
      sourceId?: string | null;
      sourceReference?: string | null;
      metadata?: Record<string, unknown>;
    }>;
    idempotencyKey?: string | null;
  };

  try {
    const entry = await createConsolidationElimination(ctx.supabase, {
      organizationId: ctx.organizationId,
      legalEntityIds: body.legalEntityIds,
      includeAllEntities: body.includeAllEntities,
      effectiveDate: body.effectiveDate,
      periodStart: body.periodStart,
      periodEnd: body.periodEnd,
      entryType: body.entryType,
      sourceKind: body.sourceKind,
      status: body.status,
      description: body.description,
      memo: body.memo,
      lines: body.lines,
      sources: body.sources,
      idempotencyKey: body.idempotencyKey,
      auth: ctx.auth,
      actorId: ctx.session.userId,
    });
    return NextResponse.json(entry);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not create elimination";
    const status = /access|permission|balance/i.test(message) ? 403 : 400;
    return jsonError(message, status);
  }
}
