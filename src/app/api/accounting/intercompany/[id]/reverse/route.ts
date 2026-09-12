import { NextResponse } from "next/server";
import { reverseIntercompanyTransaction } from "@/lib/accounting/intercompany";
import { jsonError, requireAccountingWriteBooks } from "@/lib/api";
import type { ProfileRole } from "@/types";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const ctx = await requireAccountingWriteBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { supabase, organizationId, session, auth } = ctx;
  if (!auth) return jsonError("Unauthorized", 401);

  const { id } = await context.params;
  const body = (await request.json()) as { reversalDate?: string; memo?: string };
  const reversalDate = String(body.reversalDate ?? new Date().toISOString().slice(0, 10)).slice(0, 10);

  try {
    const result = await reverseIntercompanyTransaction(supabase, {
      organizationId,
      intercompanyTransactionId: id,
      reversalDate,
      memo: body.memo,
      actorId: session.userId,
      auth: { userId: auth.userId, role: auth.role as ProfileRole },
    });
    return NextResponse.json(result);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Could not reverse intercompany transaction", 400);
  }
}
