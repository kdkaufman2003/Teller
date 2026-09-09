import { NextResponse } from "next/server";
import { jsonError, requireBooks } from "@/lib/api";
import {
  exportBudgetVsActualCsv,
  loadBudgetVsActualReport,
} from "@/lib/planning/reports/budget-vs-actual";
import { fiscalYearCalendarMonths, isValidPeriodMonth } from "@/lib/planning/budgets/periods";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const url = new URL(request.url);
  const fiscalYear = Number(url.searchParams.get("fiscalYear") ?? new Date().getFullYear());
  const versionId = url.searchParams.get("versionId");
  const format = url.searchParams.get("format");
  let throughMonth = url.searchParams.get("throughMonth");

  if (!Number.isFinite(fiscalYear) || fiscalYear < 1900) {
    return jsonError("fiscalYear is required", 400);
  }

  const months = fiscalYearCalendarMonths(fiscalYear);
  if (!throughMonth || !isValidPeriodMonth(throughMonth) || !months.includes(throughMonth)) {
    const today = new Date();
    const current = `${fiscalYear}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
    throughMonth = months.includes(current)
      ? current
      : months[Math.min(today.getMonth(), 11)]!;
  }

  try {
    const report = await loadBudgetVsActualReport(ctx.supabase, ctx.organizationId, {
      fiscalYear,
      throughMonth,
      versionId,
    });

    if (format === "csv") {
      const csv = exportBudgetVsActualCsv(report);
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="budget-vs-actual_FY${fiscalYear}.csv"`,
        },
      });
    }

    return NextResponse.json({ report });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not load report", 400);
  }
}
