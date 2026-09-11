import { NextResponse } from "next/server";
import { jsonError, requireBooks } from "@/lib/api";
import { canExportBooks, parseCpaMode } from "@/lib/accounting/cpa";
import { recordAuditEvent } from "@/lib/accounting/audit";
import { getSessionContext } from "@/lib/session";
import { runAccountantTaxPackage } from "@/lib/accounting/tax/reports/service";
import type { TaxReportKind } from "@/lib/accounting/tax/reports/types";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const session = await getSessionContext();
  const exportAllowed = canExportBooks(session?.profile?.role, parseCpaMode(session?.settings?.answers?.cpaMode));
  if (!exportAllowed) return jsonError("Export not permitted", 403);

  const url = new URL(request.url);

  try {
    const { data: org } = await ctx.supabase
      .from("teller_organizations")
      .select("name")
      .eq("id", ctx.organizationId)
      .maybeSingle();

    const result = await runAccountantTaxPackage(
      ctx.supabase,
      {
        organizationId: ctx.organizationId,
        report: "summary" as TaxReportKind,
        startDate: url.searchParams.get("startDate"),
        endDate: url.searchParams.get("endDate"),
        filingPeriodId: url.searchParams.get("filingPeriodId"),
        registrationId: url.searchParams.get("registrationId"),
        authorityId: url.searchParams.get("authorityId"),
        state: url.searchParams.get("state"),
      },
      { organizationName: (org?.name as string | null) ?? null },
    );

    await recordAuditEvent(ctx.supabase, {
      organizationId: ctx.organizationId,
      actorId: ctx.session.userId,
      action: "data.exported",
      resourceKind: "tax_accountant_package",
      resourceId: ctx.organizationId,
      metadata: {
        reportPeriodStart: result.manifest.reportPeriodStart,
        reportPeriodEnd: result.manifest.reportPeriodEnd,
        fileCount: result.files.length,
        exceptionCount: result.manifest.exceptionCount,
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not generate accountant tax package", 400);
  }
}
