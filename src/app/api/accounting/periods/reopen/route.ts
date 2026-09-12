import { NextResponse } from "next/server";
import { reopenAccountingPeriod } from "@/lib/accounting/period-close";
import { jsonError, requireAccountingAdminBooks } from "@/lib/api";

export async function POST(request: Request) {
  const ctx = await requireAccountingAdminBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, legalEntityId, session } = ctx;

  const body = (await request.json()) as { periodEnd?: string; reason?: string };
  const periodEnd = String(body.periodEnd ?? "").slice(0, 10);
  const reason = String(body.reason ?? "").trim();
  if (!periodEnd) return jsonError("periodEnd is required", 400);
  if (!reason) return jsonError("reason is required", 400);

  try {
    const result = await reopenAccountingPeriod(supabase, {
      organizationId,
      legalEntityId,
      periodEnd,
      reason,
      actorId: session.userId,
    });
    return NextResponse.json(result);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Could not reopen period", 400);
  }
}
