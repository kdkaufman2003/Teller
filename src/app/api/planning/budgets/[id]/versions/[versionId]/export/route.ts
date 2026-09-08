import { NextResponse } from "next/server";
import { jsonError, requireBooks } from "@/lib/api";
import {
  getBudgetVersion,
  listBudgetLines,
  loadPlanningAccounts,
} from "@/lib/planning/budgets/budget-crud";
import { exportBudgetCsv } from "@/lib/planning/budgets/csv";
import { isBudgetPnlAccount } from "@/lib/planning/budgets/pnl-scope";

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

    const accounts = (await loadPlanningAccounts(ctx.supabase, ctx.organizationId)).filter(
      isBudgetPnlAccount,
    );
    const accountIdsWithLines = new Set(lines.map((line) => line.accountId));
    const exportAccounts = accounts.filter((account) => accountIdsWithLines.has(account.id));

    const csv = exportBudgetCsv({
      fiscalYear: Number(budget.fiscal_year),
      accounts: exportAccounts,
      lines,
    });

    const filename = `${budget.name.replace(/[^\w\-]+/g, "_")}_FY${budget.fiscal_year}_v${version.version_number}.csv`;
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not export budget", 400);
  }
}
