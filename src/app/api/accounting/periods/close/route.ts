import { NextResponse } from "next/server";
import { closeAccountingPeriod } from "@/lib/accounting/period-close";
import { jsonError, requireAdminBooks } from "@/lib/api";

export async function POST(request: Request) {
  const ctx = await requireAdminBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const body = (await request.json()) as {
    periodEnd?: string;
    notes?: string;
    warningsAcknowledged?: unknown[];
    skipReadiness?: boolean;
  };
  const periodEnd = String(body.periodEnd ?? "").slice(0, 10);
  if (!periodEnd) return jsonError("periodEnd is required", 400);

  try {
    const result = await closeAccountingPeriod(supabase, {
      organizationId,
      periodEnd,
      notes: body.notes,
      warningsAcknowledged: body.warningsAcknowledged,
      actorId: session.userId,
      skipReadiness: body.skipReadiness,
    });
    return NextResponse.json(result);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Could not close period", 400);
  }
}
