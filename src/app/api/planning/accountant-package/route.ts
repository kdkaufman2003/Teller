import { NextResponse } from "next/server";
import { jsonError, requireBooks } from "@/lib/api";
import { buildPlanningPackageExportFiles } from "@/lib/planning/accountant-package/export";
import { loadAccountantPlanningPackage } from "@/lib/planning/accountant-package/load-accountant-planning-package";
import { getSessionContext } from "@/lib/session";
import { canExportBooks, parseCpaMode } from "@/lib/accounting/cpa";

export async function GET(request: Request) {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const url = new URL(request.url);
  const periodEnd = url.searchParams.get("periodEnd") ?? new Date().toISOString().slice(0, 10);
  const periodLabel =
    url.searchParams.get("periodLabel") ?? `Through ${periodEnd.slice(0, 7)}`;
  const fiscalYearRaw = url.searchParams.get("fiscalYear");
  const fiscalYear = fiscalYearRaw ? Number(fiscalYearRaw) : undefined;
  const format = url.searchParams.get("format") ?? "json";

  if (fiscalYearRaw && !Number.isFinite(fiscalYear)) {
    return jsonError("Invalid fiscalYear", 400);
  }

  try {
    const pkg = await loadAccountantPlanningPackage(ctx.supabase, ctx.organizationId, {
      periodEnd,
      periodLabel,
      fiscalYear,
    });

    if (format === "csv") {
      const session = await getSessionContext();
      const exportAllowed = canExportBooks(
        session?.profile?.role,
        parseCpaMode(session?.settings?.answers?.cpaMode),
      );
      if (!exportAllowed) return jsonError("Export not permitted", 403);

      const slug = session?.organization?.name ?? "organization";
      const files = buildPlanningPackageExportFiles(pkg, slug);
      return NextResponse.json({
        files: files.map((file) => ({ filename: file.filename, content: file.content })),
      });
    }

    return NextResponse.json({ package: pkg });
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Could not load accountant planning package",
      500,
    );
  }
}
