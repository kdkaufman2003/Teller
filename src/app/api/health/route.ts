import { NextResponse } from "next/server";
import { jsonError, requireBooks } from "@/lib/api";
import { computeHealthReport } from "@/lib/health/engine";
import { gatherHealthSignals } from "@/lib/health/signals";
import { hasHfacIntegration } from "@/lib/session";

export async function GET() {
  const ctx = await requireBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  try {
    const signals = await gatherHealthSignals(supabase, organizationId, {
      hfacEnabled: hasHfacIntegration(session.settings),
    });
    const report = computeHealthReport(signals);
    return NextResponse.json({ report, signals });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not compute health";
    return jsonError(message, 500);
  }
}
