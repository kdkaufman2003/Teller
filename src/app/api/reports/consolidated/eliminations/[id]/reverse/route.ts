import { NextResponse } from "next/server";
import { reverseConsolidationElimination } from "@/lib/accounting/consolidated/eliminations";
import { jsonError, requireAccountingAdminBooks } from "@/lib/api";

type RouteProps = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteProps) {
  const ctx = await requireAccountingAdminBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { idempotencyKey?: string | null };

  try {
    const result = await reverseConsolidationElimination(ctx.supabase, {
      organizationId: ctx.organizationId,
      entryId: id,
      auth: ctx.auth,
      actorId: ctx.session.userId,
      idempotencyKey: body.idempotencyKey,
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not reverse elimination";
    const status = /authorized|access|permission/i.test(message) ? 403 : 400;
    return jsonError(message, status);
  }
}
