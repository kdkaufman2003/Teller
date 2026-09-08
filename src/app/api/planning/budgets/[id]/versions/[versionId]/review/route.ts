import { NextResponse } from "next/server";
import { jsonError, requireBooks } from "@/lib/api";
import {
  getBudgetVersion,
  listBudgetLines,
} from "@/lib/planning/budgets/budget-crud";
import { buildApprovalReview } from "@/lib/planning/budgets/approval-review";

type RouteContext = { params: Promise<{ id: string; versionId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const { id, versionId } = await context.params;

  try {
    const version = await getBudgetVersion(ctx.supabase, ctx.organizationId, versionId);
    const budget = version.teller_budgets as {
      id: string;
      name: string;
      fiscal_year: number;
    };
    if (budget.id !== id) return jsonError("Version does not belong to this budget", 404);

    const linesRaw = await listBudgetLines(ctx.supabase, ctx.organizationId, versionId);
    const lines = linesRaw.map((line) => ({
      accountId: line.account_id as string,
      periodMonth: line.period_month as string,
      amount: Number(line.amount),
    }));

    const review = buildApprovalReview({
      budgetName: budget.name,
      fiscalYear: Number(budget.fiscal_year),
      versionNumber: Number(version.version_number),
      versionLabel: (version.label as string) ?? "",
      status: version.status as string,
      lines,
    });

    return NextResponse.json({ review });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not build review", 400);
  }
}
