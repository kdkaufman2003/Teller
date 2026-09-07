import { NextResponse } from "next/server";
import { startPeriodReview } from "@/lib/accounting/period-close";
import { jsonError, requireWriteBooks } from "@/lib/api";

export async function POST(request: Request) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;

  const body = (await request.json()) as { periodEnd?: string };
  const periodEnd = String(body.periodEnd ?? "").slice(0, 10);
  if (!periodEnd) return jsonError("periodEnd is required", 400);

  try {
    const review = await startPeriodReview(supabase, {
      organizationId,
      periodEnd,
      actorId: session.userId,
    });
    return NextResponse.json({ review });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Could not start review", 400);
  }
}
