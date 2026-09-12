import { NextResponse } from "next/server";
import { postConsolidationElimination } from "@/lib/accounting/consolidated/eliminations";
import { jsonError, requireAccountingAdminBooks } from "@/lib/api";

type RouteProps = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: RouteProps) {
  const ctx = await requireAccountingAdminBooks();
  if ("error" in ctx && ctx.error) return ctx.error;
  const { id } = await params;

  try {
    const entry = await postConsolidationElimination(ctx.supabase, {
      organizationId: ctx.organizationId,
      entryId: id,
      auth: ctx.auth,
      actorId: ctx.session.userId,
    });
    return NextResponse.json(entry);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not post elimination";
    const status = /authorized|access|permission/i.test(message) ? 403 : 400;
    return jsonError(message, status);
  }
}
