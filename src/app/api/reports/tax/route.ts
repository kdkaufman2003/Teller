import { NextResponse } from "next/server";
import { jsonError, requireBooks } from "@/lib/api";
import { canExportBooks, parseCpaMode } from "@/lib/accounting/cpa";
import { getSessionContext } from "@/lib/session";
import { runTaxReport, runTaxReportWithReadiness, type TaxReportQueryInput } from "@/lib/accounting/tax/reports/service";
import type { TaxReportKind } from "@/lib/accounting/tax/reports/types";
import { taxRowsToCsv } from "@/lib/accounting/tax/reports/csv";

const VALID_REPORTS: TaxReportKind[] = [
  "summary",
  "rollforward",
  "gl_reconciliation",
  "sales_detail",
  "use_detail",
  "exempt",
  "needs_review",
  "payments",
  "adjustments",
  "jurisdictions",
  "authorities",
  "filing_period",
];

function parseReportInput(url: URL, organizationId: string): TaxReportQueryInput {
  const report = url.searchParams.get("report") as TaxReportKind;
  if (!VALID_REPORTS.includes(report)) {
    throw new Error(`Invalid report. Expected one of: ${VALID_REPORTS.join(", ")}`);
  }
  return {
    organizationId,
    report,
    startDate: url.searchParams.get("startDate"),
    endDate: url.searchParams.get("endDate"),
    filingPeriodId: url.searchParams.get("filingPeriodId"),
    registrationId: url.searchParams.get("registrationId"),
    authorityId: url.searchParams.get("authorityId"),
    state: url.searchParams.get("state"),
    taxType: url.searchParams.get("taxType"),
    determinationStatus: url.searchParams.get("determinationStatus"),
    jurisdictionKey: url.searchParams.get("jurisdictionKey"),
    limit: url.searchParams.get("limit"),
    offset: url.searchParams.get("offset"),
  };
}

function reportToCsv(report: unknown, kind: TaxReportKind): string {
  if (kind === "summary" && report && typeof report === "object") {
    const summary = report as Record<string, number | string>;
    return taxRowsToCsv(
      [
        {
          taxableSales: summary.taxableSales,
          exemptSales: summary.exemptSales,
          salesTaxAccrued: summary.salesTaxAccrued,
          useTaxAccrued: summary.useTaxAccrued,
          authorityPayments: summary.authorityPayments,
          netLiabilityChange: summary.netLiabilityChange,
        },
      ],
      [
        { key: "taxableSales", header: "Taxable Sales" },
        { key: "exemptSales", header: "Exempt Sales" },
        { key: "salesTaxAccrued", header: "Sales Tax Accrued" },
        { key: "useTaxAccrued", header: "Use Tax Accrued" },
        { key: "authorityPayments", header: "Tax Payments" },
        { key: "netLiabilityChange", header: "Net Liability Change" },
      ],
    );
  }

  if (report && typeof report === "object" && "rows" in report) {
    const paginated = report as { rows: Array<Record<string, unknown>> };
    if (paginated.rows.length === 0) return "";
    const keys = Object.keys(paginated.rows[0]!);
    return taxRowsToCsv(
      paginated.rows.map((row) => Object.fromEntries(keys.map((key) => [key, row[key] as string | number | null]))),
      keys.map((key) => ({ key, header: key })),
    );
  }

  return taxRowsToCsv([{ payload: JSON.stringify(report) }], [{ key: "payload", header: "Report" }]);
}

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const url = new URL(request.url);
  const format = url.searchParams.get("format") ?? "json";
  const includeReadiness = url.searchParams.get("includeReadiness") === "true";

  try {
    const input = parseReportInput(url, ctx.organizationId);

    if (format === "csv") {
      const session = await getSessionContext();
      const exportAllowed = canExportBooks(session?.profile?.role, parseCpaMode(session?.settings?.answers?.cpaMode));
      if (!exportAllowed) return jsonError("Export not permitted", 403);
    }

    const payload = includeReadiness
      ? await runTaxReportWithReadiness(ctx.supabase, input)
      : { report: await runTaxReport(ctx.supabase, input) };

    if (format === "csv") {
      const csv = reportToCsv("report" in payload ? payload.report : payload, input.report);
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="tax-${input.report}.csv"`,
        },
      });
    }

    return NextResponse.json(payload);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not generate tax report", 400);
  }
}
