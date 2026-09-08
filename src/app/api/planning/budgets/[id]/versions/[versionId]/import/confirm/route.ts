import { NextResponse } from "next/server";
import { jsonError, requireWriteBooks } from "@/lib/api";
import {
  applyBudgetCsvImport,
  getBudgetVersion,
  loadPlanningAccounts,
} from "@/lib/planning/budgets/budget-crud";
import {
  buildBudgetCsvPreview,
  sanitizeImportFilename,
} from "@/lib/planning/budgets/csv";
import { assertLinesEditable } from "@/lib/planning/budgets/lifecycle";
import type { BudgetCsvImportMode, BudgetVersionStatus } from "@/lib/planning/budgets/types";

type RouteContext = { params: Promise<{ id: string; versionId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const { id, versionId } = await context.params;
  const body = (await request.json()) as {
    csv?: string;
    filename?: string;
    mode?: BudgetCsvImportMode;
  };

  if (!body.csv?.trim()) return jsonError("csv content is required", 400);
  const mode: BudgetCsvImportMode = body.mode === "merge" ? "merge" : "replace";

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

    if (preview.errors.length) {
      return jsonError(`Import blocked: ${preview.errors[0]?.message ?? "validation failed"}`, 400);
    }
    if (!preview.lines.length) {
      return jsonError("Import has no budget values to save", 400);
    }

    const result = await applyBudgetCsvImport(ctx.supabase, {
      organizationId: ctx.organizationId,
      budgetId: id,
      versionId,
      fiscalYear: Number(budget.fiscal_year),
      lines: preview.lines,
      mode,
      actorId: ctx.session.userId,
      sourceFilename: sanitizeImportFilename(body.filename ?? "import.csv"),
    });

    return NextResponse.json({ saved: result.saved, preview });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Import failed", 400);
  }
}
