import { NextResponse } from "next/server";
import { jsonError, requireWriteBooks } from "@/lib/api";
import {
  cloneBudgetVersion,
  getBudgetVersion,
  runBudgetVersionLifecycle,
} from "@/lib/planning/budgets/budget-crud";
import type { BudgetVersionAction } from "@/lib/planning/budgets/types";

type RouteContext = { params: Promise<{ id: string; versionId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const { id, versionId } = await context.params;
  const body = (await request.json()) as {
    action?: BudgetVersionAction | "clone";
    label?: string;
  };

  if (!body.action) return jsonError("action is required", 400);

  try {
    const version = await getBudgetVersion(ctx.supabase, ctx.organizationId, versionId);
    const budget = version.teller_budgets as { id: string };
    if (budget.id !== id) return jsonError("Version does not belong to this budget", 404);

    if (body.action === "clone") {
      const cloned = await cloneBudgetVersion(ctx.supabase, {
        organizationId: ctx.organizationId,
        sourceVersionId: versionId,
        label: body.label,
        actorId: ctx.session.userId,
      });
      return NextResponse.json({ version: cloned });
    }

    const updated = await runBudgetVersionLifecycle(ctx.supabase, {
      organizationId: ctx.organizationId,
      versionId,
      action: body.action,
      actorId: ctx.session.userId,
    });
    return NextResponse.json({ version: updated });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Lifecycle action failed", 400);
  }
}
