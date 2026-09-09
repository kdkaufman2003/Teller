import { NextResponse } from "next/server";
import { jsonError, requireWriteBooks } from "@/lib/api";
import {
  archiveForecastVersion,
  cloneForecastVersion,
  publishForecastVersion,
} from "@/lib/planning/forecasts/forecast-crud";
import {
  buildPublishSnapshotFromReport,
  loadRollingForecastReport,
} from "@/lib/planning/reports/rolling-forecast";
import { resolveActualCutoffMonth } from "@/lib/planning/forecasts/periods";

type RouteContext = { params: Promise<{ id: string; versionId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const { id, versionId } = await context.params;
  const body = (await request.json()) as {
    action?: "publish" | "revision" | "archive";
    label?: string;
    actualCutoffMonth?: string;
  };

  if (!body.action) {
    return jsonError("action is required", 400);
  }

  try {
    if (body.action === "publish") {
      const report = await loadRollingForecastReport(ctx.supabase, ctx.organizationId, {
        forecastId: id,
        versionId,
      });
      const snapshotLines = await buildPublishSnapshotFromReport(
        ctx.supabase,
        ctx.organizationId,
        report,
      );
      const result = await publishForecastVersion(ctx.supabase, {
        organizationId: ctx.organizationId,
        forecastId: id,
        versionId,
        actualCutoffMonth:
          body.actualCutoffMonth ??
          resolveActualCutoffMonth(null, report.anchorMonth),
        snapshotLines,
        actorId: ctx.session.userId,
      });
      return NextResponse.json({ version: result });
    }

    if (body.action === "revision") {
      const result = await cloneForecastVersion(ctx.supabase, {
        organizationId: ctx.organizationId,
        sourceVersionId: versionId,
        label: body.label,
        actorId: ctx.session.userId,
      });
      return NextResponse.json({ version: result });
    }

    if (body.action === "archive") {
      const result = await archiveForecastVersion(ctx.supabase, {
        organizationId: ctx.organizationId,
        versionId,
        actorId: ctx.session.userId,
      });
      return NextResponse.json({ version: result });
    }

    return jsonError("Unknown action", 400);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Lifecycle action failed", 400);
  }
}
