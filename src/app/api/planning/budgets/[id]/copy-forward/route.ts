import { NextResponse } from "next/server";
import { jsonError, requireWriteBooks } from "@/lib/api";
import { copyBudgetForward, getBudgetWithVersions } from "@/lib/planning/budgets/budget-crud";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const { id } = await context.params;
  const body = (await request.json()) as {
    sourceVersionId?: string;
    targetFiscalYear?: number;
    name?: string;
  };

  if (!body.sourceVersionId || body.targetFiscalYear == null || !body.name) {
    return jsonError("sourceVersionId, targetFiscalYear, and name are required", 400);
  }

  try {
    await getBudgetWithVersions(ctx.supabase, ctx.organizationId, id);
    const result = await copyBudgetForward(ctx.supabase, {
      organizationId: ctx.organizationId,
      sourceBudgetId: id,
      sourceVersionId: body.sourceVersionId,
      targetFiscalYear: Number(body.targetFiscalYear),
      name: body.name,
      actorId: ctx.session.userId,
    });
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not copy budget", 400);
  }
}
