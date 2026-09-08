import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import {
  getBudgetVersion,
  loadPlanningAccounts,
} from "@/lib/planning/budgets/budget-crud";
import { buildBudgetCsvPreview, sanitizeImportFilename } from "@/lib/planning/budgets/csv";
import { assertLinesEditable } from "@/lib/planning/budgets/lifecycle";
import type { BudgetVersionStatus } from "@/lib/planning/budgets/types";

type RouteContext = { params: Promise<{ id: string; versionId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const { id, versionId } = await context.params;
  const body = (await request.json()) as { csv?: string; filename?: string };

  if (!body.csv?.trim()) return jsonError("csv content is required", 400);

  try {
    const version = await getBudgetVersion(ctx.supabase, ctx.organizationId, versionId);
    const budget = version.teller_budgets as { id: string; fiscal_year: number };
    if (budget.id !== id) return jsonError("Version does not belong to this budget", 404);

    assertLinesEditable(version.status as BudgetVersionStatus);

    const accounts = await loadPlanningAccounts(ctx.supabase, ctx.organizationId);
    const preview = buildBudgetCsvPreview({
      content: body.csv,
      fiscalYear: Number(budget.fiscal_year),
      organizationId: ctx.organizationId,
      accounts: accounts.map((account) => ({
        id: account.id,
        code: account.code,
        name: account.name,
        organizationId: ctx.organizationId,
        type: account.type,
        archived: account.archived,
      })),
    });

    return NextResponse.json({
      preview,
      filename: sanitizeImportFilename(body.filename ?? "import.csv"),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not preview import", 400);
  }
}
