import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import {
  bulkUpsertBudgetLines,
  getBudgetVersion,
  listBudgetLines,
} from "@/lib/planning/budgets/budget-crud";
import type { BudgetLineInput } from "@/lib/planning/budgets/types";

type RouteContext = { params: Promise<{ id: string; versionId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const { id, versionId } = await context.params;

  try {
    const version = await getBudgetVersion(ctx.supabase, ctx.organizationId, versionId);
    const budget = version.teller_budgets as { id: string };
    if (budget.id !== id) return jsonError("Version does not belong to this budget", 404);

    const lines = await listBudgetLines(ctx.supabase, ctx.organizationId, versionId);
    return NextResponse.json({ version, lines });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not load version", 404);
  }
}

export async function PUT(request: Request, context: RouteContext) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const { id, versionId } = await context.params;
  const body = (await request.json()) as {
    fiscalYear?: number;
    lines?: BudgetLineInput[];
  };

  if (body.fiscalYear == null || !Array.isArray(body.lines)) {
    return jsonError("fiscalYear and lines array are required", 400);
  }

  try {
    const version = await getBudgetVersion(ctx.supabase, ctx.organizationId, versionId);
    const budget = version.teller_budgets as { id: string };
    if (budget.id !== id) return jsonError("Version does not belong to this budget", 404);

    const result = await bulkUpsertBudgetLines(ctx.supabase, {
      organizationId: ctx.organizationId,
      budgetId: id,
      versionId,
      fiscalYear: Number(body.fiscalYear),
      lines: body.lines,
      actorId: ctx.session.userId,
    });
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not save lines", 400);
  }
}
