import { NextResponse } from "next/server";
import { reverseAccrualSettlement } from "@/lib/accounting/accrual-settlement/settlement-service";
import { jsonError, requireWriteBooks } from "@/lib/api";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const ctx = await requireWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session } = ctx;
  const { id } = await context.params;

  const body = (await request.json()) as { reversalDate?: string };
  const reversalDate = body.reversalDate ?? new Date().toISOString().slice(0, 10);

  try {
    const result = await reverseAccrualSettlement(supabase, {
      organizationId,
      settlementId: id,
      reversalDate,
      actorId: session.userId,
    });
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Reversal failed", 400);
  }
}
