import { NextResponse } from "next/server";
import { jsonError, requireBooks, requireWriteBooks } from "@/lib/api";
import {
  DEFAULT_PLANNING_SETTINGS,
  parsePlanningSettings,
  planningSettingsToRow,
} from "@/lib/planning/settings/planning-settings";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const { data, error } = await ctx.supabase
    .from("teller_planning_settings")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();

  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) {
      return NextResponse.json({ settings: DEFAULT_PLANNING_SETTINGS, schemaReady: false });
    }
    return jsonError(error.message, 500);
  }

  return NextResponse.json({
    settings: parsePlanningSettings(data),
    schemaReady: true,
  });
}

export async function PATCH(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;

  const body = (await request.json()) as Record<string, unknown>;
  const row = planningSettingsToRow(ctx.organizationId, {
    defaultArCollectionDays:
      body.defaultArCollectionDays != null ? Number(body.defaultArCollectionDays) : undefined,
    defaultApPaymentDays:
      body.defaultApPaymentDays != null ? Number(body.defaultApPaymentDays) : undefined,
    forecastHorizonMonths:
      body.forecastHorizonMonths != null ? Number(body.forecastHorizonMonths) : undefined,
    cashPlanningGrain: body.cashPlanningGrain as "weekly" | "monthly" | undefined,
    payrollCadence: body.payrollCadence as
      | "weekly"
      | "biweekly"
      | "semimonthly"
      | "monthly"
      | undefined,
    runwayThreshold: body.runwayThreshold != null ? Number(body.runwayThreshold) : undefined,
  }, ctx.session.userId);

  const { data, error } = await ctx.supabase
    .from("teller_planning_settings")
    .upsert(row, { onConflict: "organization_id" })
    .select("*")
    .single();

  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) {
      return jsonError("Apply migration 032 to enable planning settings", 503);
    }
    return jsonError(error.message, 500);
  }

  return NextResponse.json({ settings: parsePlanningSettings(data) });
}
